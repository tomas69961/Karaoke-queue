'use strict';
/*
 * Karaoke queue server.
 *
 *   Guests scan the QR code  ->  /            (search, preview, add songs, claim roulette)
 *   Host / TV                ->  /host?key=…  (plays songs, pause/restart/skip, host search)
 *
 * Settings (environment variables, all optional):
 *   PREFERRED_CHANNELS  extra preferred channels, comma list. The built-in list (below) is
 *                     always included; set to "none" to turn preferred channels off.
 *   ROULETTE          "0" turns off karaoke roulette (default on)
 *   YOUTUBE_API_KEY   REQUIRED for song search (free Google API key, YouTube Data API v3)
 *   PORT              default 3000
 *   HOST_KEY          password for the host page (random if unset; printed at start)
 *   PUBLIC_URL        the address phones should open (auto-detected when running locally)
 *   MAX_PER_SINGER    songs one person may have queued at once (default 2)
 *   BREAK_SECONDS     pause between songs (default 10)
 *   CATALOG_PAGES     pages of 50 uploads read per channel (default 20 = 1,000 videos)
 *   TRUSTED_CHANNELS  non-preferred karaoke channels treated as karaoke even if
 *                     the title omits the word (default below)
 */
const express = require('express');
const QRCode = require('qrcode');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { classify, parseVideoId, inferGenre, parseSongTitle } = require('./classify');
const { createCatalog, defaultLoadChannel } = require('./catalog');
const { HOUR, buildTaste, recommend, pickRoulette, composeMessage } = require('./brain');

class UserError extends Error {
  constructor(message, status = 400, extra = null) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const DEFAULT_TRUSTED = 'Sing King,KaraFun Karaoke,Karaoke Version,Stingray Karaoke,Zoom Karaoke,Lucky Voice';
const DEFAULT_CHANNELS = ['@7clouds', '@melodymavel1', '@countryhype', '@Queenbee12234', '@oarmusic', '@phantomrecordsco', '@arms444and0'];
const WINDOW_48H = 48 * HOUR;
const NO_REPEAT = 18 * HOUR;

function lanUrl(port) {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) return `http://${i.address}:${port}`;
    }
  }
  return `http://localhost:${port}`;
}

// Asks YouTube's public oEmbed endpoint for the title and channel. It also
// fails for private, deleted, or embedding-disabled videos, which would not
// play on the host screen anyway.
async function defaultFetchMeta(videoId) {
  const target = 'https://www.youtube.com/watch?v=' + videoId;
  const url = 'https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(target);
  let r;
  try {
    r = await fetch(url, { signal: AbortSignal.timeout(7000) });
  } catch {
    throw new UserError("Couldn't reach YouTube to check that song. Please try again.", 502);
  }
  if (r.status === 401 || r.status === 403) {
    throw new UserError("That video can't be played here (embedding is disabled). Pick another version.", 422);
  }
  if (r.status === 404 || r.status === 400) {
    throw new UserError("Couldn't find that video. It may be private or deleted.", 422);
  }
  if (!r.ok) throw new UserError("Couldn't check that song right now. Please try again.", 502);
  const j = await r.json();
  return { title: j.title || '', author: j.author_name || '' };
}

function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return named[e.toLowerCase()] ?? m;
  });
}

// YouTube Data API v3 search. Each uncached search costs 100 of the 10,000 daily quota units.
async function defaultSearch(q, apiKey, channelId, order) {
  const params = new URLSearchParams({
    part: 'snippet', type: 'video', maxResults: '20', q, key: apiKey,
    videoEmbeddable: 'true', videoSyndicated: 'true', safeSearch: 'moderate',
  });
  if (channelId) params.set('channelId', channelId);
  if (order) params.set('order', order);
  let r;
  try {
    r = await fetch('https://www.googleapis.com/youtube/v3/search?' + params, { signal: AbortSignal.timeout(8000) });
  } catch {
    throw new UserError("Couldn't reach YouTube right now. Please try again.", 502);
  }
  if (r.status === 403) throw new UserError("Search is paused (YouTube's daily limit was reached). Ask the host.", 503);
  if (!r.ok) throw new UserError("Couldn't search right now. Please try again.", 502);
  const j = await r.json();
  return (j.items || [])
    .filter((i) => i.id && i.id.videoId)
    .map((i) => ({
      videoId: i.id.videoId,
      title: decodeEntities(i.snippet.title),
      author: decodeEntities(i.snippet.channelTitle),
    }));
}

// Turns "@somechannel" (or a UC… channel id) into the channel's id and display name.
async function defaultResolveChannel(handle, apiKey) {
  if (!apiKey) throw new UserError('Song search is not set up yet. Ask the host.', 503);
  const p = new URLSearchParams({ part: 'id,snippet', key: apiKey });
  if (/^UC[\w-]{22}$/.test(handle)) p.set('id', handle);
  else p.set('forHandle', handle.startsWith('@') ? handle : '@' + handle);
  let r;
  try {
    r = await fetch('https://www.googleapis.com/youtube/v3/channels?' + p, { signal: AbortSignal.timeout(8000) });
  } catch {
    throw new UserError("Couldn't reach YouTube right now. Please try again.", 502);
  }
  if (!r.ok) throw new UserError("Couldn't look up that YouTube channel right now. Please try again.", 502);
  const item = ((await r.json()).items || [])[0];
  if (!item) throw new UserError(`Couldn't find the YouTube channel ${handle}. Check the spelling.`, 404);
  return { id: item.id, title: (item.snippet && item.snippet.title) || '' };
}

// Best-effort genre for one video (1 quota unit). Returns null when YouTube gives no clue.
async function defaultLookupGenre(videoId, apiKey) {
  if (!apiKey) return null;
  const p = new URLSearchParams({ part: 'snippet,topicDetails', id: videoId, key: apiKey });
  try {
    const r = await fetch('https://www.googleapis.com/youtube/v3/videos?' + p, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const it = ((await r.json()).items || [])[0];
    if (!it) return null;
    return inferGenre({
      topics: (it.topicDetails && it.topicDetails.topicCategories) || [],
      tags: (it.snippet && it.snippet.tags) || [],
    });
  } catch {
    return null;
  }
}

function createApp(opts = {}) {
  const flag = (v) => ['1', 'true', 'yes'].includes(String(v ?? '').toLowerCase());
  const cfg = {
    port: Number(opts.port ?? process.env.PORT ?? 3000),
    hostKey: String(opts.hostKey || process.env.HOST_KEY || crypto.randomBytes(3).toString('hex')),
    publicUrl: String(opts.publicUrl || process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, ''),
    maxPerSinger: Number(opts.maxPerSinger ?? process.env.MAX_PER_SINGER ?? 2),
    breakMs: Number(opts.breakMs ?? (process.env.BREAK_SECONDS !== undefined ? Number(process.env.BREAK_SECONDS) * 1000 : 10000)),
    trusted: String(opts.trusted ?? process.env.TRUSTED_CHANNELS ?? DEFAULT_TRUSTED)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    dataFile: opts.dataFile === undefined ? path.join(__dirname, 'data', 'state.json') : opts.dataFile,
  };
  cfg.youtubeApiKey = String(opts.youtubeApiKey || process.env.YOUTUBE_API_KEY || '');

  // Preferred channels: the built-in list plus any extras from PREFERRED_CHANNELS.
  const envList = String(process.env.PREFERRED_CHANNELS ?? process.env.ALLOWED_CHANNELS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  let rawCh;
  if (opts.channels !== undefined) rawCh = Array.isArray(opts.channels) ? opts.channels : [opts.channels];
  else if (envList.some((s) => /^(off|none)$/i.test(s))) rawCh = [];
  else rawCh = [...DEFAULT_CHANNELS, ...envList];
  const seenCh = new Set();
  cfg.channels = rawCh
    .map((s) => String(s).trim())
    .filter((s) => {
      const k = s.toLowerCase().replace(/^@/, '');
      if (!s || /^(any|off|none)$/i.test(s) || seenCh.has(k)) return false;
      seenCh.add(k);
      return true;
    });
  const bareName = (h) => h.replace(/^@/, '');

  const fetchMeta = opts.fetchMeta || defaultFetchMeta;
  const resolveChannel = opts.resolveChannel || ((h) => defaultResolveChannel(h, cfg.youtubeApiKey));
  const search = opts.search || ((q, channelId, order) => defaultSearch(q, cfg.youtubeApiKey, channelId, order));
  const lookupGenre = opts.lookupGenre || ((id) => defaultLookupGenre(id, cfg.youtubeApiKey));
  const random = opts.random || Math.random;
  const now = opts.now || Date.now;
  const loader = opts.loadChannel
    || (cfg.youtubeApiKey ? (h) => defaultLoadChannel(h, cfg.youtubeApiKey, Number(process.env.CATALOG_PAGES || 20)) : null);
  const catalog = createCatalog({ handles: cfg.channels, loadChannel: loader, now, log: opts.quiet ? null : console.warn });
  const searchEnabled = Boolean(opts.search || cfg.youtubeApiKey || opts.loadChannel);
  const searchCache = new Map();
  cfg.roulette = !['0', 'false', 'off', 'no'].includes(String(opts.roulette ?? process.env.ROULETTE ?? '1').toLowerCase());

  // ---------- state ----------
  const state = {
    queue: [],
    nowPlaying: null,
    history: [],
    genreCounts: {},
    stats: {},          // videoId -> how often it was requested (all time) for the Top 25
    requests: [],       // recent requests (for the 48-hour taste profile)
    rouletteLog: [],    // roulette songs already played (18-hour no-repeat)
    roulettePick: null, // the roulette song waiting to be claimed or played
    paused: false,
    restartNonce: 0,
    break: null,        // { until, nextId, message } between songs
  };

  if (cfg.dataFile) {
    try {
      const s = JSON.parse(fs.readFileSync(cfg.dataFile, 'utf8'));
      state.queue = (s.queue || []).filter((q) => q.status !== 'review').map((q) => ({ ...q, status: 'queued' }));
      state.history = s.history || [];
      state.genreCounts = s.genreCounts || {};
      state.stats = s.stats || {};
      state.requests = s.requests || [];
      state.rouletteLog = s.rouletteLog || [];
      if (s.nowPlaying) state.queue.unshift({ ...s.nowPlaying, status: 'queued', playNext: true });
    } catch {
      /* first run */
    }
  }

  let saveTimer;
  function save() {
    if (!cfg.dataFile) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(cfg.dataFile), { recursive: true });
        const { queue, nowPlaying, history, genreCounts, stats, requests, rouletteLog } = state;
        fs.writeFileSync(cfg.dataFile, JSON.stringify({ queue, nowPlaying, history, genreCounts, stats, requests, rouletteLog }));
      } catch (e) {
        console.error('Could not save queue:', e.message);
      }
    }, 200);
    saveTimer.unref();
  }

  // Fair rotation: everyone's 1st song, then everyone's 2nd, and so on. A claimed roulette
  // song carries a minimum round so it lands at the bottom. Songs the host marked
  // "play next" jump ahead in the order they were marked.
  function ranked() {
    const seen = {};
    return state.queue
      .filter((q) => q.status === 'queued')
      .map((q, i) => {
        const k = q.singer.toLowerCase();
        seen[k] = (seen[k] || 0) + 1;
        return { q, round: Math.max(seen[k], q.minRound || 0), i };
      })
      .sort((a, b) => {
        if (a.q.playNext !== b.q.playNext) return a.q.playNext ? -1 : 1;
        if (a.q.playNext) return (a.q.playNextAt || 0) - (b.q.playNextAt || 0) || a.i - b.i;
        return a.round - b.round || a.i - b.i;
      });
  }
  const upcoming = () => ranked().map((x) => x.q);

  const pub = (q) =>
    q && {
      id: q.id,
      videoId: q.videoId,
      title: q.title,
      channel: q.channel,
      singer: q.roulette ? '🎲 Roulette' : q.open || !q.singer ? '🎤 Open mic' : q.singer,
      open: !!(q.open || !q.singer),
      roulette: !!q.roulette,
      nonPreferred: !!q.nonPreferred,
      thumb: `https://i.ytimg.com/vi/${q.videoId}/mqdefault.jpg`,
      startedAt: q.startedAt || null,
    };

  const recentRequests = () => {
    const cut = now() - WINDOW_48H;
    state.requests = state.requests.filter((r) => r.at >= cut).slice(-600);
    return state.requests;
  };
  const taken = () => new Set([...state.queue.map((q) => q.videoId), ...(state.nowPlaying ? [state.nowPlaying.videoId] : [])]);

  function topGenre() {
    const top = Object.entries(state.genreCounts || {}).sort((a, b) => b[1] - a[1])[0];
    return top ? top[0] : null;
  }

  const view = () => {
    const b = state.break;
    let next = null;
    if (b) {
      const q = state.queue.find((x) => x.id === b.nextId) || (state.roulettePick && state.roulettePick.id === b.nextId ? state.roulettePick : null);
      next = pub(q || upcoming()[0] || (cfg.roulette ? state.roulettePick : null));
    }
    return {
      serverNow: now(),
      nowPlaying: pub(state.nowPlaying),
      upcoming: upcoming().map(pub),
      roulettePick: cfg.roulette ? pub(state.roulettePick) : null,
      paused: state.paused,
      restartNonce: state.restartNonce,
      break: b ? { until: b.until, next, message: b.message } : null,
      settings: {
        maxPerSinger: cfg.maxPerSinger, searchEnabled, channels: cfg.channels.map(bareName), breakMs: cfg.breakMs,
        roulette: { enabled: cfg.roulette && catalog.channels().length > 0, genre: topGenre() },
      },
    };
  };

  // ---------- live updates (server-sent events) ----------
  const clients = new Set();
  function changed() {
    save();
    const msg = `data: ${JSON.stringify(view())}\n\n`;
    for (const res of clients) res.write(msg);
  }
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, 25000);
  heartbeat.unref();

  // ---------- requests, stats ----------
  function requestRecord(item, singer) {
    return {
      at: now(), singer, videoId: item.videoId, title: item.title, channel: item.channel,
      artist: item.artist || '', artistKey: item.artistKey || '', genre: item.genre || null,
    };
  }
  function recordRequest(item) {
    if (!item.singer) return;
    state.requests.push(requestRecord(item, item.singer));
    const s = state.stats[item.videoId] || { videoId: item.videoId, title: item.title, channel: item.channel, count: 0, preferred: !item.nonPreferred };
    s.count += 1;
    s.lastAt = now();
    state.stats[item.videoId] = s;
    const keys = Object.keys(state.stats);
    if (keys.length > 1500) {
      keys.sort((a, b) => state.stats[a].count - state.stats[b].count || state.stats[a].lastAt - state.stats[b].lastAt);
      for (const k of keys.slice(0, keys.length - 1500)) delete state.stats[k];
    }
  }

  // ---------- roulette ----------
  const pubEntry = (e) => ({
    videoId: e.videoId, title: e.title, channel: e.channel, preferred: true,
    thumb: `https://i.ytimg.com/vi/${e.videoId}/mqdefault.jpg`, inQueue: taken().has(e.videoId),
  });
  const newItem = (info, extra) => ({
    id: crypto.randomBytes(5).toString('hex'),
    token: crypto.randomBytes(12).toString('hex'),
    videoId: info.videoId, title: String(info.title).slice(0, 200), channel: String(info.channel).slice(0, 100),
    artist: info.artist || '', artistKey: info.artistKey || '', genre: info.genre || null,
    status: 'queued', addedAt: now(), playNext: false, nonPreferred: !!info.nonPreferred, singer: '', ...extra,
  });
  const makePick = (e) => newItem(e, { roulette: true, open: true });

  let avoidId = null;
  let pickBusy = null;
  function ensureRoulettePick() {
    if (!cfg.roulette) return Promise.resolve();
    if (pickBusy) return pickBusy;
    pickBusy = (async () => {
      try {
        await catalog.ensure();
        const t = taken();
        if (state.roulettePick && !t.has(state.roulettePick.videoId) && state.roulettePick.videoId !== avoidId) return;
        state.roulettePick = null;
        const cut = now() - NO_REPEAT;
        const recentlyPlayed = new Set([
          ...state.rouletteLog.filter((r) => r.at >= cut).map((r) => r.videoId),
          ...state.history.filter((h) => (h.startedAt || 0) >= cut).map((h) => h.videoId),
        ]);
        if (avoidId) t.add(avoidId);
        const e = pickRoulette(catalog.entries(), {
          taste: buildTaste(recentRequests()), exclude: t, recentlyPlayed, genre: topGenre(), random,
        });
        avoidId = null;
        if (e) state.roulettePick = makePick(e);
        changed();
      } catch (e) {
        if (!opts.quiet) console.error('Roulette pick failed:', e.message);
      } finally {
        pickBusy = null;
      }
    })();
    return pickBusy;
  }

  // ---------- "up next" message between songs ----------
  function messageFor(item) {
    const reqs = recentRequests();
    const by = new Map();
    for (const r of reqs) {
      const k = r.singer.toLowerCase();
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(r);
    }
    const people = [...by.values()].map((rs) => ({ name: rs[rs.length - 1].singer, requests: rs }));
    const exclude = new Set([...taken(), ...reqs.map((r) => r.videoId)]);
    const song = item ? parseSongTitle(item.title).song || item.title : '';
    return composeMessage({
      next: item ? { singer: item.singer, title: song, kind: item.roulette ? 'roulette' : item.open || !item.singer ? 'open' : 'singer' } : null,
      people,
      random,
      recFor: (rs) => recommend(catalog.entries(), buildTaste(rs), { exclude, limit: 1 })[0] || null,
    });
  }

  // ---------- helpers ----------
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10kb' }));

  function rateLimit(max, windowMs) {
    const hits = new Map();
    return (req, res, next) => {
      const t = Date.now();
      const arr = (hits.get(req.ip) || []).filter((x) => t - x < windowMs);
      if (arr.length >= max) return res.status(429).json({ error: 'Slow down a little and try again in a minute.' });
      arr.push(t);
      hits.set(req.ip, arr);
      next();
    };
  }

  const sameKey = (a, b) => {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };
  const isHost = (req) => sameKey(req.get('x-host-key') || '', cfg.hostKey);
  const requireHost = (req, res, next) =>
    isHost(req) ? next() : res.status(401).json({ error: 'Wrong or missing host key.' });

  function joinUrl(req) {
    if (cfg.publicUrl) return cfg.publicUrl;
    const host = req.get('host') || '';
    if (host && !/^(localhost|127\.|\[::1\])/.test(host)) return `${req.protocol}://${host}`;
    return lanUrl(cfg.port);
  }

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const clean = (v, n = 60) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, n);

  // What we know about a video: from the local index when it is a preferred-channel
  // video, otherwise from YouTube (oEmbed) and the title filter.
  async function describe(videoId, { force = false } = {}) {
    const e = catalog.byId(videoId);
    if (e) return { videoId, title: e.title, channel: e.channel, preferred: true, genre: e.genre, artist: e.artist, artistKey: e.artistKey };
    const meta = await fetchMeta(videoId);
    const preferred = catalog.isPreferredAuthor(meta.author);
    if (!preferred && !force) {
      const v = classify(meta, { trusted: cfg.trusted });
      if (v.result === 'reject') throw new UserError(v.reason, 422);
    }
    let genre = null;
    try { genre = (await lookupGenre(videoId)) || null; } catch { /* genre is optional */ }
    const p = parseSongTitle(meta.title);
    return { videoId, title: meta.title, channel: meta.author, preferred, genre, artist: p.artist, artistKey: p.artistKey };
  }

  // ---------- search ----------
  async function runSearch(p, { host = false } = {}) {
    const artist = clean(p.artist);
    const song = clean(p.song);
    const handle = clean(p.handle).replace(/^@/, '');
    const q = host ? clean(p.q) : '';
    if (![artist, song, handle, q].some((x) => x.length >= 2)) {
      throw new UserError('Fill in at least one of: artist, song title or YouTube handle.');
    }
    if (!searchEnabled) throw new UserError('Song search is not set up yet. Ask the host.', 503);

    await catalog.ensure();
    const local = catalog.search({ artist, song, handle, q });
    const otherHandle = handle && !local.handleMatched;
    const needBroad = otherHandle || (!local.handleMatched && local.results.length < 6);

    let broad = [];
    if (needBroad) {
      const text = [artist, song, q].filter(Boolean).join(' ');
      const query = `${text || 'popular'} karaoke with lyrics`;
      const key = `${query.toLowerCase()}|${handle.toLowerCase()}`;
      try {
        let hit = searchCache.get(key);
        if (!hit || Date.now() - hit.at > 10 * 60 * 1000) {
          let channelId;
          if (otherHandle) channelId = (await resolveChannel(handle)).id;
          hit = { at: Date.now(), raw: await search(query, channelId) };
          searchCache.set(key, hit);
          if (searchCache.size > 200) searchCache.delete(searchCache.keys().next().value);
        }
        broad = hit.raw;
      } catch (e) {
        if (!local.results.length) throw e;
      }
    }

    const t = taken();
    const seen = new Set();
    const prefList = [];
    const otherList = [];
    for (const e of local.results.slice(0, 15)) {
      seen.add(e.videoId);
      prefList.push({ videoId: e.videoId, title: e.title, channel: e.channel, preferred: true });
    }
    const scored = [];
    for (const m of broad) {
      if (seen.has(m.videoId)) continue;
      seen.add(m.videoId);
      const indexed = catalog.byId(m.videoId);
      if (indexed || catalog.isPreferredAuthor(m.author)) {
        prefList.push({ videoId: m.videoId, title: m.title, channel: m.author, preferred: true });
        continue;
      }
      const v = classify(m, { trusted: cfg.trusted });
      if (v.result === 'reject') continue;
      scored.push({ m, rank: v.result === 'accept' ? 0 : 1 });
    }
    scored.sort((a, b) => a.rank - b.rank);
    for (const { m } of scored) otherList.push({ videoId: m.videoId, title: m.title, channel: m.author, preferred: false });
    const results = [...prefList.slice(0, 15), ...otherList].slice(0, 20).map((r) => ({
      ...r, thumb: `https://i.ytimg.com/vi/${r.videoId}/mqdefault.jpg`, inQueue: t.has(r.videoId),
    }));
    return results;
  }

  // ---------- public API ----------
  app.get('/api/state', (req, res) => {
    res.json(view());
    if (!state.roulettePick) void ensureRoulettePick();
  });

  app.get('/api/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write(`data: ${JSON.stringify(view())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
  });

  app.get('/api/join', (req, res) => res.json({ url: joinUrl(req) }));

  app.get('/qr.svg', wrap(async (req, res) => {
    const svg = await QRCode.toString(joinUrl(req), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
  }));

  app.get('/api/search', rateLimit(30, 60000), wrap(async (req, res) => {
    res.json({ results: await runSearch(req.query) });
  }));

  // Top-25 most requested songs, plus recommendations from the last 48 hours of requests.
  app.get('/api/discover', rateLimit(40, 60000), wrap(async (req, res) => {
    await catalog.ensure();
    const t = taken();
    const top = Object.values(state.stats)
      .filter((s) => s.count > 0)
      .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)
      .slice(0, 25)
      .map((s) => ({
        videoId: s.videoId, title: s.title, channel: s.channel, count: s.count, preferred: s.preferred !== false,
        thumb: `https://i.ytimg.com/vi/${s.videoId}/mqdefault.jpg`, inQueue: t.has(s.videoId),
      }));
    const reqs = recentRequests();
    const exclude = new Set([...t, ...reqs.map((r) => r.videoId)]);
    const recommended = recommend(catalog.entries(), buildTaste(reqs), { exclude, limit: 10 }).map(pubEntry);
    res.json({ top, recommended });
  }));

  function checkLimits(singer, videoId) {
    if (state.queue.some((q) => q.videoId === videoId) || state.nowPlaying?.videoId === videoId) {
      throw new UserError('That song is already in the queue.', 409);
    }
    const mine = state.queue.filter((q) => q.singer && q.singer.toLowerCase() === singer.toLowerCase()).length;
    if (mine >= cfg.maxPerSinger) {
      throw new UserError(`You can have ${cfg.maxPerSinger} songs in the queue at once. Add another after one plays.`, 429);
    }
  }

  app.post('/api/queue', rateLimit(15, 60000), wrap(async (req, res) => {
    const singer = clean(req.body.singer, 24);
    if (!singer) throw new UserError('Please enter your name first.');
    const videoId = parseVideoId(req.body.videoId || req.body.url);
    if (!videoId) throw new UserError("Couldn't tell which song that is. Search for it and tap Add.");
    checkLimits(singer, videoId);

    const info = await describe(videoId);
    if (!info.preferred && req.body.confirmNonPreferred !== true) {
      throw new UserError("This isn't a preferred video and probably doesn't have the singer singing the song. Add it anyway?", 409, { needsConfirm: true });
    }
    checkLimits(singer, videoId);   // re-check after the network wait in case of a double tap

    const item = newItem({ ...info, nonPreferred: !info.preferred }, { singer });
    state.queue.push(item);
    recordRequest(item);
    changed();
    void ensureRoulettePick();
    res.status(201).json({ item: pub(item), token: item.token });
  }));

  // Claim the roulette song, or any "open mic" song the host added, with your name.
  // A claimed roulette song goes to the bottom of the queue (or plays next if the queue is empty).
  app.post('/api/claim', rateLimit(15, 60000), wrap(async (req, res) => {
    const singer = clean(req.body.singer, 24);
    if (!singer) throw new UserError('Please enter your name first.');
    const id = String(req.body.id || '');
    const pick = state.roulettePick && state.roulettePick.id === id ? state.roulettePick : null;
    const open = pick ? null : state.queue.find((q) => q.id === id && (q.open || !q.singer));
    if (!pick && !open) throw new UserError('Someone just claimed that one. Try another!', 409);
    const mine = state.queue.filter((q) => q.singer && q.singer.toLowerCase() === singer.toLowerCase()).length;
    if (mine >= cfg.maxPerSinger) {
      throw new UserError(`You can have ${cfg.maxPerSinger} songs in the queue at once. Add another after one plays.`, 429);
    }
    let item;
    if (pick) {
      const maxRound = ranked().reduce((m, x) => Math.max(m, x.round), 0);
      state.roulettePick = null;
      item = { ...pick, singer, roulette: false, open: false, token: crypto.randomBytes(12).toString('hex'), addedAt: now(), minRound: maxRound };
      state.queue.push(item);
    } else {
      item = open;
      item.singer = singer;
      item.open = false;
      item.token = crypto.randomBytes(12).toString('hex');
    }
    recordRequest(item);
    changed();
    await ensureRoulettePick();
    res.status(201).json({ item: pub(item), token: item.token });
  }));

  // A guest removes their own song with the token returned when they added it;
  // the host can remove anything with the host key.
  app.delete('/api/queue/:id', (req, res) => {
    const q = state.queue.find((x) => x.id === req.params.id);
    if (!q) return res.status(404).json({ error: 'Not in the queue any more.' });
    const owner = q.token && sameKey(req.get('x-owner-token') || '', q.token);
    if (!owner && !isHost(req)) return res.status(403).json({ error: 'You can only remove your own songs.' });
    state.queue = state.queue.filter((x) => x !== q);
    changed();
    void ensureRoulettePick();
    res.json({ ok: true });
  });

  // ---------- host API ----------
  app.get('/api/host/check', requireHost, (req, res) => res.json({ ok: true }));

  function startPlaying(item) {
    item.startedAt = now();
    state.nowPlaying = item;
    state.paused = false;
    state.break = null;
    if (item.roulette) {
      state.rouletteLog.push({ videoId: item.videoId, at: now() });
      state.rouletteLog = state.rouletteLog.filter((r) => r.at >= now() - 48 * HOUR);
    } else if (item.genre) {
      state.genreCounts[item.genre] = (state.genreCounts[item.genre] || 0) + 1;
    }
  }

  async function takeNext() {
    await ensureRoulettePick();
    const n = upcoming()[0];
    if (n) {
      state.queue = state.queue.filter((q) => q !== n);
      return n;
    }
    if (cfg.roulette && state.roulettePick) {
      const p = state.roulettePick;
      state.roulettePick = null;
      return p;
    }
    return null;
  }

  // The current song is over (or skipped). A 10-second break follows, with a funny
  // "up next" message, then the host page calls /start.
  app.post('/api/host/next', requireHost, wrap(async (req, res) => {
    // expectId stops two host tabs (or a double event) from skipping two songs.
    if ('expectId' in req.body && (state.nowPlaying?.id ?? null) !== req.body.expectId) return res.json(view());
    if (state.nowPlaying) {
      state.history.unshift(state.nowPlaying);
      state.history = state.history.slice(0, 30);
    }
    state.nowPlaying = null;
    state.paused = false;
    state.break = null;
    await ensureRoulettePick();
    const next = upcoming()[0] || (cfg.roulette ? state.roulettePick : null);
    if (next && cfg.breakMs > 0) {
      state.break = { until: now() + cfg.breakMs, nextId: next.id, message: messageFor(next) };
    } else if (next) {
      const item = await takeNext();
      if (item) startPlaying(item);
    }
    changed();
    void ensureRoulettePick();
    res.json(view());
  }));

  // Starts the next song. Used when the break is over, for "start now", and for the very first song.
  app.post('/api/host/start', requireHost, wrap(async (req, res) => {
    const early = state.break && now() < state.break.until - 800 && req.body.force !== true;
    if (state.nowPlaying || early) return res.json(view());
    const item = await takeNext();
    if (item) startPlaying(item);
    else state.break = null;
    changed();
    void ensureRoulettePick();
    res.json(view());
  }));

  app.post('/api/host/pause', requireHost, (req, res) => {
    if (!state.nowPlaying) return res.status(409).json({ error: 'Nothing is playing.' });
    state.paused = req.body.paused === undefined ? !state.paused : Boolean(req.body.paused);
    changed();
    res.json(view());
  });

  app.post('/api/host/restart', requireHost, (req, res) => {
    if (!state.nowPlaying) return res.status(409).json({ error: 'Nothing is playing.' });
    state.restartNonce += 1;
    state.paused = false;
    state.nowPlaying.startedAt = now();
    changed();
    res.json(view());
  });

  // "Skip for now": the first song waiting is moved back one place, so the song
  // after it plays next. The skipped song stays in line right behind it.
  app.post('/api/host/defer/:id', requireHost, (req, res) => {
    const [first, second] = upcoming();
    if (!first || first.id !== req.params.id) {
      return res.status(409).json({ error: 'That song is no longer the next one up.' });
    }
    if (!second) return res.status(409).json({ error: 'There is no song after it to move up.' });
    second.playNext = true;
    second.playNextAt = first.playNext ? (first.playNextAt || 0) - 1 : now();
    changed();
    res.json({ ok: true });
  });

  app.post('/api/host/playnext/:id', requireHost, (req, res) => {
    const q = state.queue.find((x) => x.id === req.params.id && x.status === 'queued');
    if (!q) return res.status(404).json({ error: 'Song not found.' });
    q.playNext = true;
    q.playNextAt = now();
    changed();
    res.json({ ok: true });
  });

  // Roulette controls: { action: 'on' | 'off' | 'shuffle' }
  app.post('/api/host/roulette', requireHost, wrap(async (req, res) => {
    const a = String(req.body.action || '');
    if (a === 'off') { cfg.roulette = false; state.roulettePick = null; }
    else if (a === 'on') cfg.roulette = true;
    else if (a === 'shuffle') {
      if (!cfg.roulette) throw new UserError('Roulette is turned off.', 403);
      avoidId = state.roulettePick ? state.roulettePick.videoId : null;
      state.roulettePick = null;
    } else throw new UserError('Unknown roulette action.');
    changed();
    await ensureRoulettePick();
    changed();
    res.json(view());
  }));

  // Host search: free text and/or artist / song / handle.
  app.get('/api/host/search', requireHost, rateLimit(60, 60000), wrap(async (req, res) => {
    res.json({ results: await runSearch(req.query, { host: true }) });
  }));

  // Host add: target "queue" (with a singer name, or blank = open mic that guests can claim)
  // or "roulette" (becomes the roulette song).
  app.post('/api/host/add', requireHost, wrap(async (req, res) => {
    const videoId = parseVideoId(req.body.videoId || req.body.url);
    if (!videoId) throw new UserError("Couldn't tell which song that is.");
    const target = req.body.target === 'roulette' ? 'roulette' : 'queue';
    const singer = clean(req.body.singer, 24);
    if (state.queue.some((q) => q.videoId === videoId) || state.nowPlaying?.videoId === videoId) {
      throw new UserError('That song is already in the queue.', 409);
    }
    const info = await describe(videoId, { force: true });
    if (target === 'roulette') {
      if (!cfg.roulette) throw new UserError('Roulette is turned off.', 403);
      state.roulettePick = makePick({ ...info, nonPreferred: !info.preferred });
    } else {
      const item = newItem({ ...info, nonPreferred: !info.preferred }, { singer, open: !singer });
      state.queue.push(item);
      recordRequest(item);
    }
    changed();
    res.status(201).json(view());
  }));

  // Three suggestions that fit the room's artists/genres and the current song.
  app.get('/api/host/recs', requireHost, wrap(async (req, res) => {
    await catalog.ensure();
    const reqs = recentRequests().slice();
    if (state.nowPlaying && !state.nowPlaying.roulette) {
      reqs.push(requestRecord(state.nowPlaying, state.nowPlaying.singer || 'host'));
    }
    const exclude = new Set([...taken(), ...reqs.map((r) => r.videoId)]);
    const recs = recommend(catalog.entries(), buildTaste(reqs), { exclude, limit: 3, perArtist: 1 }).map(pubEntry);
    res.json({ recs });
  }));

  // Only these files are served; nothing else in the folder is exposed.
  const page = (f) => (req, res) => res.sendFile(path.join(__dirname, f));
  app.get('/', page('guest.html'));
  app.get('/host', page('host.html'));
  app.get('/style.css', page('style.css'));

  app.use((err, req, res, next) => {
    if (err instanceof UserError) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });

  if (opts.autoload !== false && loader) {
    catalog.ensure().then(() => ensureRoulettePick()).catch(() => {});
    const refresh = setInterval(() => { catalog.ensure(); }, 30 * 60 * 1000);
    refresh.unref();
  }

  return { app, cfg, state, catalog, ensureRoulettePick };
}

module.exports = { createApp };

if (require.main === module) {
  const { app, cfg } = createApp();
  app.listen(cfg.port, () => {
    const base = cfg.publicUrl || lanUrl(cfg.port);
    console.log('\n  🎤  Karaoke queue is running\n');
    console.log(`  Guests (QR code points here):  ${base}/`);
    console.log(`  Host / TV screen:              ${base}/host?key=${cfg.hostKey}`);
    console.log(cfg.channels.length
      ? `  Preferred channels:            ${cfg.channels.join(', ')}`
      : '  Preferred channels:            none');
    if (!cfg.youtubeApiKey) {
      console.log('\n  ⚠️  Song search is OFF. Set YOUTUBE_API_KEY (free, from Google Cloud Console →');
      console.log('      enable "YouTube Data API v3" → Credentials → API key) and restart.');
    }
    console.log('');
  });
}
