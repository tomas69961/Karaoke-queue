'use strict';
/*
 * Karaoke queue server.
 *
 *   Guests scan the QR code  ->  /            (add songs, see the queue)
 *   Host / TV laptop         ->  /host?key=…  (plays songs, approves, skips)
 *
 * Settings (environment variables, all optional):
 *   PREFERRED_CHANNELS  channels listed first in search results (default "@7clouds";
 *                     comma list, or "none"). Other channels are listed after them.
 *   YOUTUBE_API_KEY   REQUIRED for song search (free Google API key, YouTube Data API v3)
 *   PORT              default 3000
 *   HOST_KEY          password for the host page (random if unset; printed at start)
 *   PUBLIC_URL        the address phones should open, e.g. https://karaoke.example.com
 *                     (auto-detected from your wifi address when running locally)
 *   MAX_PER_SINGER    songs one person may have queued at once (default 2)
 *   STRICT            "1" = reject titles that don't say the singer's vocals are on
 *                     instead of holding them for host approval
 *   TRUSTED_CHANNELS  comma list of karaoke channels treated as karaoke even if
 *                     the title omits the word (default below)
 */
const express = require('express');
const QRCode = require('qrcode');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { classify, parseVideoId } = require('./classify');

class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const DEFAULT_TRUSTED = 'Sing King,KaraFun Karaoke,Karaoke Version,Stingray Karaoke,Zoom Karaoke,Lucky Voice';

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

// YouTube Data API v3 search. Needs a free API key (YOUTUBE_API_KEY).
// Each uncached search costs 100 of the 10,000 daily quota units.
async function defaultSearch(q, apiKey, channelId) {
  const params = new URLSearchParams({
    part: 'snippet', type: 'video', maxResults: '20', q, key: apiKey,
    videoEmbeddable: 'true', videoSyndicated: 'true', safeSearch: 'moderate',
  });
  if (channelId) params.set('channelId', channelId);
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

// Turns "@7clouds" (or a UC… channel id) into the channel's id and display name.
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
  if (!r.ok) throw new UserError("Couldn't look up the karaoke channel right now. Please try again.", 502);
  const item = ((await r.json()).items || [])[0];
  if (!item) throw new UserError(`Couldn't find the YouTube channel ${handle}. Ask the host.`, 503);
  return { id: item.id, title: (item.snippet && item.snippet.title) || '' };
}

function createApp(opts = {}) {
  const flag = (v) => ['1', 'true', 'yes'].includes(String(v ?? '').toLowerCase());
  const cfg = {
    port: Number(opts.port ?? process.env.PORT ?? 3000),
    hostKey: String(opts.hostKey || process.env.HOST_KEY || crypto.randomBytes(3).toString('hex')),
    publicUrl: String(opts.publicUrl || process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, ''),
    maxPerSinger: Number(opts.maxPerSinger ?? process.env.MAX_PER_SINGER ?? 2),
    strict: flag(opts.strict ?? process.env.STRICT),
    trusted: String(opts.trusted ?? process.env.TRUSTED_CHANNELS ?? DEFAULT_TRUSTED)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    dataFile: opts.dataFile === undefined ? path.join(__dirname, 'data', 'state.json') : opts.dataFile,
  };
  cfg.youtubeApiKey = String(opts.youtubeApiKey || process.env.YOUTUBE_API_KEY || '');
  const fetchMeta = opts.fetchMeta || defaultFetchMeta;
  const rawCh = opts.channels !== undefined ? opts.channels : String(process.env.PREFERRED_CHANNELS ?? process.env.ALLOWED_CHANNELS ?? '@7clouds').split(',');
  cfg.channels = (Array.isArray(rawCh) ? rawCh : [rawCh])
    .map((s) => String(s).trim())
    .filter((s) => s && !/^(any|off|none)$/i.test(s));
  const resolveChannel = opts.resolveChannel || ((h) => defaultResolveChannel(h, cfg.youtubeApiKey));
  const resolvedChannels = new Map();
  async function channelInfo(h) {
    if (!resolvedChannels.has(h)) resolvedChannels.set(h, await resolveChannel(h));
    return resolvedChannels.get(h);
  }
  const bareName = (h) => h.replace(/^@/, '');
  async function allowedNames() {
    const names = new Set();
    for (const h of cfg.channels) {
      names.add(bareName(h).toLowerCase());
      try {
        const ch = await channelInfo(h);
        if (ch.title) names.add(ch.title.toLowerCase());
      } catch { /* the handle itself is the fallback */ }
    }
    return names;
  }
  const search = opts.search || ((q, channelId) => defaultSearch(q, cfg.youtubeApiKey, channelId));
  const searchEnabled = Boolean(opts.search || cfg.youtubeApiKey);
  const searchCache = new Map();

  // ---------- state ----------
  const state = { queue: [], nowPlaying: null, history: [] };

  if (cfg.dataFile) {
    try {
      const s = JSON.parse(fs.readFileSync(cfg.dataFile, 'utf8'));
      state.queue = s.queue || [];
      state.history = s.history || [];
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
        fs.writeFileSync(cfg.dataFile, JSON.stringify(state));
      } catch (e) {
        console.error('Could not save queue:', e.message);
      }
    }, 200);
    saveTimer.unref();
  }

  // Fair rotation: everyone's 1st song, then everyone's 2nd, and so on.
  // Songs the host marked "play next" jump ahead in the order they were marked.
  function upcoming() {
    const seen = {};
    return state.queue
      .filter((q) => q.status === 'queued')
      .map((q, i) => {
        const k = q.singer.toLowerCase();
        seen[k] = (seen[k] || 0) + 1;
        return { q, round: seen[k], i };
      })
      .sort((a, b) => {
        if (a.q.playNext !== b.q.playNext) return a.q.playNext ? -1 : 1;
        if (a.q.playNext) return (a.q.playNextAt || 0) - (b.q.playNextAt || 0) || a.i - b.i;
        return a.round - b.round || a.i - b.i;
      })
      .map((x) => x.q);
  }

  const pub = (q) =>
    q && {
      id: q.id,
      videoId: q.videoId,
      title: q.title,
      channel: q.channel,
      singer: q.singer,
      status: q.status,
      thumb: `https://i.ytimg.com/vi/${q.videoId}/mqdefault.jpg`,
      startedAt: q.startedAt || null,
    };

  const view = () => ({
    nowPlaying: pub(state.nowPlaying),
    upcoming: upcoming().map(pub),
    review: state.queue.filter((q) => q.status === 'review').map(pub),
    settings: { maxPerSinger: cfg.maxPerSinger, strict: cfg.strict, searchEnabled, channels: cfg.channels.map(bareName) },
  });

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

  // ---------- helpers ----------
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10kb' }));

  function rateLimit(max, windowMs) {
    const hits = new Map();
    return (req, res, next) => {
      const now = Date.now();
      const arr = (hits.get(req.ip) || []).filter((t) => now - t < windowMs);
      if (arr.length >= max) return res.status(429).json({ error: 'Slow down a little and try again in a minute.' });
      arr.push(now);
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

  // ---------- public API ----------
  app.get('/api/state', (req, res) => res.json(view()));

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

  // Guests search by song or artist. "karaoke with lyrics" is
  // added to every query, and only results that pass the karaoke filter come back.
  app.get('/api/search', rateLimit(30, 60000), wrap(async (req, res) => {
    const q = String(req.query.q || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (q.length < 2) throw new UserError('Type a song or an artist.');
    if (!searchEnabled) throw new UserError('Song search is not set up yet. Ask the host.', 503);

    const key = q.toLowerCase();
    let hit = searchCache.get(key);
    if (!hit || Date.now() - hit.at > 10 * 60 * 1000) {
      // The preferred channel(s) and a broad search run side by side. If one fails
      // the other still answers; only both failing is an error.
      const broad = search(`${q} karaoke with lyrics`);
      const fromPreferred = Promise.all(cfg.channels.map(async (h) => {
        const ch = await channelInfo(h);
        return (await search(`${q} karaoke with lyrics`, ch.id)).map((m) => ({ ...m, fromChannel: true }));
      }));
      const [b, p] = await Promise.allSettled([broad, fromPreferred]);
      if (b.status === 'rejected' && p.status === 'rejected') throw b.reason;
      const pref = p.status === 'fulfilled' ? p.value.flat() : [];
      const prefIds = new Set(pref.map((m) => m.videoId));
      const rest = b.status === 'fulfilled' ? b.value.filter((m) => !prefIds.has(m.videoId)) : [];
      hit = { at: Date.now(), raw: [...pref, ...rest] };
      searchCache.set(key, hit);
      if (searchCache.size > 200) searchCache.delete(searchCache.keys().next().value);
    }

    const taken = new Set(state.queue.map((x) => x.videoId));
    if (state.nowPlaying) taken.add(state.nowPlaying.videoId);
    // Preferred-channel videos go first and are trusted as-is. Everything else
    // goes below them and must pass the title filter.
    const names = cfg.channels.length ? await allowedNames() : new Set();
    const isPref = (m) => m.fromChannel || names.has(String(m.author).trim().toLowerCase());
    const rank = (x) =>
      x.p ? (/karaoke|lyrics/i.test(x.m.title) ? 0 : 1) : x.v.result === 'accept' ? 2 : 3;
    const sorted = hit.raw
      .map((m) => {
        const p = isPref(m);
        return { m, p, v: p ? { result: 'accept' } : classify(m, { trusted: cfg.trusted, strict: cfg.strict }) };
      })
      .filter((x) => x.v.result !== 'reject')
      .sort((a, b) => rank(a) - rank(b));
    const top = sorted.filter((x) => x.p).slice(0, 5);
    const results = [...top, ...sorted.filter((x) => !x.p).slice(0, 10 - top.length)]
      .map(({ m, v, p }) => ({
        preferred: p,
        videoId: m.videoId,
        title: m.title,
        channel: m.author,
        thumb: `https://i.ytimg.com/vi/${m.videoId}/mqdefault.jpg`,
        status: v.result,
        inQueue: taken.has(m.videoId),
      }));
    res.json({ results });
  }));

  app.post('/api/queue', rateLimit(15, 60000), wrap(async (req, res) => {
    const singer = String(req.body.singer || '').replace(/\s+/g, ' ').trim().slice(0, 24);
    if (!singer) throw new UserError('Please enter your name first.');
    const videoId = parseVideoId(req.body.videoId || req.body.url);
    if (!videoId) throw new UserError("Couldn't tell which song that is. Search for it and tap Add.");

    const dup = () => state.queue.some((q) => q.videoId === videoId) || state.nowPlaying?.videoId === videoId;
    const mineCount = () => state.queue.filter((q) => q.singer.toLowerCase() === singer.toLowerCase()).length;
    if (dup()) throw new UserError('That song is already in the queue.', 409);
    if (mineCount() >= cfg.maxPerSinger) {
      throw new UserError(`You can have ${cfg.maxPerSinger} songs in the queue at once. Add another after one plays.`, 429);
    }

    const meta = await fetchMeta(videoId);
    // Preferred channel: added straight away. Any other channel must pass the
    // karaoke title filter, and unclear ones wait for the host.
    const names = cfg.channels.length ? await allowedNames() : new Set();
    let verdict;
    if (names.has(String(meta.author).trim().toLowerCase())) {
      verdict = { result: 'accept', reason: 'From the karaoke channel.' };
    } else {
      verdict = classify(meta, { trusted: cfg.trusted, strict: cfg.strict });
      if (verdict.result === 'reject') throw new UserError(verdict.reason, 422);
    }

    // Re-check after the network wait in case a double-tap slipped through.
    if (dup()) throw new UserError('That song is already in the queue.', 409);
    if (mineCount() >= cfg.maxPerSinger) throw new UserError(`You can have ${cfg.maxPerSinger} songs in the queue at once.`, 429);

    const item = {
      id: crypto.randomBytes(5).toString('hex'),
      token: crypto.randomBytes(12).toString('hex'),
      videoId,
      title: String(meta.title).slice(0, 200),
      channel: String(meta.author).slice(0, 100),
      singer,
      status: verdict.result === 'accept' ? 'queued' : 'review',
      addedAt: Date.now(),
      playNext: false,
    };
    state.queue.push(item);
    changed();
    res.status(201).json({ item: pub(item), token: item.token, message: verdict.reason });
  }));

  // A guest removes their own song with the token returned when they added it;
  // the host can remove anything with the host key.
  app.delete('/api/queue/:id', (req, res) => {
    const q = state.queue.find((x) => x.id === req.params.id);
    if (!q) return res.status(404).json({ error: 'Not in the queue any more.' });
    const owner = sameKey(req.get('x-owner-token') || '', q.token);
    if (!owner && !isHost(req)) return res.status(403).json({ error: "You can only remove your own songs." });
    state.queue = state.queue.filter((x) => x !== q);
    changed();
    res.json({ ok: true });
  });

  // ---------- host API ----------
  app.get('/api/host/check', requireHost, (req, res) => res.json({ ok: true }));

  app.post('/api/host/next', requireHost, (req, res) => {
    // expectId stops two host tabs (or a double event) from skipping two songs.
    if ('expectId' in req.body && (state.nowPlaying?.id ?? null) !== req.body.expectId) {
      return res.json(view());
    }
    if (state.nowPlaying) {
      state.history.unshift(state.nowPlaying);
      state.history = state.history.slice(0, 30);
    }
    const next = upcoming()[0];
    if (next) {
      state.queue = state.queue.filter((q) => q !== next);
      next.startedAt = Date.now();
      state.nowPlaying = next;
    } else {
      state.nowPlaying = null;
    }
    changed();
    res.json(view());
  });

  app.post('/api/host/approve/:id', requireHost, (req, res) => {
    const q = state.queue.find((x) => x.id === req.params.id && x.status === 'review');
    if (!q) return res.status(404).json({ error: 'Nothing to approve.' });
    q.status = 'queued';
    changed();
    res.json({ ok: true });
  });

  app.post('/api/host/playnext/:id', requireHost, (req, res) => {
    const q = state.queue.find((x) => x.id === req.params.id && x.status === 'queued');
    if (!q) return res.status(404).json({ error: 'Song not found.' });
    q.playNext = true;
    q.playNextAt = Date.now();
    changed();
    res.json({ ok: true });
  });

  // ---------- pages ----------
  // Only these three files are served; nothing else in the folder is exposed.
  const page = (f) => (req, res) => res.sendFile(path.join(__dirname, f));
  app.get('/', page('guest.html'));
  app.get('/host', page('host.html'));
  app.get('/style.css', page('style.css'));

  app.use((err, req, res, next) => {
    if (err instanceof UserError) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });

  return { app, cfg, state };
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
      ? `  Listed first (top picks):      ${cfg.channels.join(', ')}  (other channels after, held for OK if unclear)`
      : `  Singer-vocals rule:            ${cfg.strict ? 'strict (reject if not stated)' : 'hold unclear ones for host approval'}`);
    if (!cfg.youtubeApiKey) {
      console.log('\n  ⚠️  Song search is OFF. Set YOUTUBE_API_KEY (free, from Google Cloud Console →');
      console.log('      enable "YouTube Data API v3" → Credentials → API key) and restart.');
    }
    console.log('');
  });
}
