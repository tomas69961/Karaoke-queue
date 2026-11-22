'use strict';
/*
 * Local index of the preferred karaoke channels.
 *
 * Instead of paying 100 quota units for every YouTube search, the server reads each
 * preferred channel's upload list once (about 40 units per channel, refreshed every
 * 12 hours) and searches that copy in memory. Searching it costs nothing, and the same
 * copy powers roulette, recommendations and the top-25 list.
 */
const { inferGenre, normalizeText, tokenize, queryTokens, coverage, parseSongTitle } = require('./classify');

const bare = (h) => String(h || '').replace(/^@/, '');
const compact = (s) => normalizeText(s).replace(/ /g, '');
const NOT_A_SONG = /\b(compilation|medley|non[\s-]?stop|full album|playlist|\d+\s*hours?)\b/i;

function makeEntry(v, ch) {
  const p = parseSongTitle(v.title);
  return {
    videoId: v.videoId,
    title: v.title,
    channel: ch.title,
    handle: ch.handle,
    views: Number(v.views) || 0,
    genre: v.genre || null,
    artist: p.artist,
    song: p.song,
    artistKey: p.artistKey,
    songKey: p.songKey,
    isSong: !NOT_A_SONG.test(v.title) && (/karaoke|lyric|sing[\s-]?along/i.test(v.title) || Boolean(p.artist)),
    titleTokens: tokenize(v.title),
    channelTokens: tokenize(`${ch.title} ${ch.handle}`),
  };
}

// ---------- real YouTube loader (uses the Data API; ~1 unit per call) ----------
async function gjson(pathName, params, apiKey) {
  const p = new URLSearchParams({ ...params, key: apiKey });
  let r;
  try {
    r = await fetch(`https://www.googleapis.com/youtube/v3/${pathName}?${p}`, { signal: AbortSignal.timeout(10000) });
  } catch {
    throw new Error('could not reach YouTube');
  }
  if (!r.ok) throw new Error(`YouTube answered ${r.status}`);
  return r.json();
}

async function defaultLoadChannel(handle, apiKey, maxPages = 20) {
  const p = { part: 'snippet,contentDetails' };
  if (/^UC[\w-]{22}$/.test(handle)) p.id = handle;
  else p.forHandle = handle.startsWith('@') ? handle : '@' + handle;
  const ch = ((await gjson('channels', p, apiKey)).items || [])[0];
  if (!ch) throw new Error('channel not found');
  const uploads = ch.contentDetails && ch.contentDetails.relatedPlaylists && ch.contentDetails.relatedPlaylists.uploads;
  if (!uploads) throw new Error('channel has no uploads');
  const ids = [];
  let pageToken;
  for (let i = 0; i < maxPages; i++) {
    const pj = await gjson('playlistItems', { part: 'contentDetails', playlistId: uploads, maxResults: '50', ...(pageToken ? { pageToken } : {}) }, apiKey);
    for (const it of pj.items || []) if (it.contentDetails && it.contentDetails.videoId) ids.push(it.contentDetails.videoId);
    pageToken = pj.nextPageToken;
    if (!pageToken) break;
  }
  const videos = [];
  for (let i = 0; i < ids.length; i += 50) {
    const vj = await gjson('videos', { part: 'snippet,statistics,topicDetails,status', id: ids.slice(i, i + 50).join(','), maxResults: '50' }, apiKey);
    for (const v of vj.items || []) {
      if (v.status && v.status.embeddable === false) continue;
      videos.push({
        videoId: v.id,
        title: (v.snippet && v.snippet.title) || '',
        views: v.statistics && v.statistics.viewCount,
        genre: inferGenre({
          topics: (v.topicDetails && v.topicDetails.topicCategories) || [],
          tags: (v.snippet && v.snippet.tags) || [],
        }),
      });
    }
  }
  return { id: ch.id, title: ch.snippet.title, handle: bare(ch.snippet.customUrl || handle), videos };
}

// ---------- the index ----------
function createCatalog({ handles = [], loadChannel = null, ttlMs = 12 * 3600 * 1000, retryMs = 10 * 60 * 1000, now = Date.now, log = console.warn } = {}) {
  const loaded = new Map();   // requested handle -> { info, entries }
  let flat = [];
  let byIdMap = new Map();
  let infos = [];
  let loadedAt = 0;
  let failedAt = 0;
  let loading = null;

  function rebuild() {
    flat = [];
    infos = [];
    for (const h of handles) {
      const l = loaded.get(h);
      if (!l) continue;
      infos.push(l.info);
      flat.push(...l.entries);
    }
    byIdMap = new Map(flat.map((e) => [e.videoId, e]));
  }

  async function load() {
    const results = await Promise.allSettled(handles.map((h) => loadChannel(h)));
    let ok = 0;
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        ok++;
        const c = r.value;
        const info = { id: c.id, title: c.title, handle: bare(c.handle || handles[i]) };
        loaded.set(handles[i], { info, entries: c.videos.map((v) => makeEntry(v, info)) });
      } else if (log) {
        log(`Could not load channel ${handles[i]}: ${r.reason && r.reason.message}`);
      }
    });
    if (ok) { loadedAt = now(); rebuild(); } else failedAt = now();
  }

  // Resolves when the index is ready (or has failed). Refreshing a stale index
  // happens in the background, so searches never wait for it.
  function ensure() {
    if (!loadChannel || !handles.length) return Promise.resolve();
    if (loading) return loadedAt ? Promise.resolve() : loading;
    const stale = loadedAt && now() - loadedAt > ttlMs;
    if (loadedAt && !stale) return Promise.resolve();
    if (!loadedAt && failedAt && now() - failedAt < retryMs) return Promise.resolve();
    loading = load().catch(() => { failedAt = now(); }).finally(() => { loading = null; });
    return loadedAt ? Promise.resolve() : loading;
  }

  const names = () => {
    const s = new Set();
    for (const h of handles) s.add(bare(h).toLowerCase());
    for (const i of infos) { s.add(String(i.title).toLowerCase()); s.add(String(i.handle).toLowerCase()); }
    return s;
  };

  function matchChannel(text) {
    const n = compact(bare(text));
    if (n.length < 2) return [];
    return infos.filter((i) => {
      const hs = [compact(i.handle), compact(i.title)];
      return hs.some((x) => x === n || (n.length >= 4 && (x.startsWith(n) || n.startsWith(x))));
    });
  }

  /**
   * Fuzzy search over the preferred channels. Any of artist / song / handle / q may be
   * filled; every field that is filled has to match, and the more of them match (and the
   * closer), the higher the result ranks.
   */
  function search({ artist = '', song = '', handle = '', q = '', limit = 40 } = {}) {
    const aT = queryTokens(artist);
    const sT = queryTokens(song);
    const qT = queryTokens(q);
    let scope = flat;
    let handleMatched = false;
    if (String(handle).trim()) {
      const ms = matchChannel(handle);
      if (!ms.length) return { results: [], handleMatched: false };
      handleMatched = true;
      const keep = new Set(ms.map((m) => m.handle));
      scope = flat.filter((e) => keep.has(e.handle));
    }
    const aKey = normalizeText(artist);
    const sKey = normalizeText(song);
    const out = [];
    for (const e of scope) {
      const covs = [];
      let boost = 0;
      if (aT.length) {
        covs.push(coverage(aT, e.titleTokens));
        if (aKey && e.artistKey === aKey) boost += 0.3;
      }
      if (sT.length) {
        covs.push(coverage(sT, e.titleTokens));
        if (sKey && e.songKey === sKey) boost += 0.3;
      }
      if (qT.length) covs.push(coverage(qT, e.titleTokens.concat(e.channelTokens)));
      if (covs.some((c) => c < 0.65)) continue;
      const score = covs.length ? covs.reduce((a, b) => a + b, 0) / covs.length + boost : 1;
      out.push({ e, score });
    }
    out.sort((x, y) => y.score - x.score || y.e.views - x.e.views);
    return { results: out.slice(0, limit).map((x) => ({ ...x.e, score: x.score })), handleMatched };
  }

  return {
    ensure,
    search,
    entries: () => flat,
    songs: () => flat.filter((e) => e.isSong),
    byId: (id) => byIdMap.get(id) || null,
    channels: () => infos.slice(),
    ready: () => loadedAt > 0,
    isPreferredAuthor: (author) => names().has(String(author || '').trim().toLowerCase()),
    matchChannel,
  };
}

module.exports = { createCatalog, defaultLoadChannel, makeEntry };
