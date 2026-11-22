'use strict';
/*
 * Taste matching: what the room has been requesting -> recommendations, roulette picks
 * and the funny "up next" messages. Everything here is plain scoring over the local
 * channel index (catalog.js); nothing calls YouTube.
 *
 * "Taste" means artists, genres and channels of the songs requested in the last 48 hours.
 * Genres are only known when YouTube tags the video, so artist and channel matches
 * do most of the work.
 */

const HOUR = 3600 * 1000;

function buildTaste(reqs) {
  const t = { artists: new Map(), genres: new Map(), channels: new Map(), total: reqs.length };
  const bump = (m, k) => { if (k) m.set(k, (m.get(k) || 0) + 1); };
  for (const r of reqs) { bump(t.artists, r.artistKey); bump(t.genres, r.genre); bump(t.channels, r.channel); }
  return t;
}

function matchParts(e, taste) {
  return {
    artist: (e.artistKey && taste.artists.get(e.artistKey)) || 0,
    genre: (e.genre && taste.genres.get(e.genre)) || 0,
    channel: taste.channels.get(e.channel) || 0,
  };
}

function scoreEntry(e, taste) {
  const m = matchParts(e, taste);
  return m.artist * 3 + m.genre * 1.5 + Math.min(m.channel, 3) * 0.5 + Math.log10((e.views || 0) + 10) * 0.05;
}

const relevant = (e, taste) => {
  const m = matchParts(e, taste);
  return m.artist > 0 || m.genre > 0 || m.channel > 0;
};

// Songs that fit the taste, never songs picked at random. Empty when there is no taste yet.
function recommend(entries, taste, { exclude = new Set(), limit = 10, perArtist = 2 } = {}) {
  if (!taste.total) return [];
  const scored = entries
    .filter((e) => e.isSong && !exclude.has(e.videoId) && relevant(e, taste))
    .map((e) => ({ e, s: scoreEntry(e, taste) }))
    .sort((a, b) => b.s - a.s || b.e.views - a.e.views);
  const out = [];
  const per = new Map();
  for (const { e } of scored) {
    const k = e.artistKey || e.videoId;
    if ((per.get(k) || 0) >= perArtist) continue;
    per.set(k, (per.get(k) || 0) + 1);
    out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}

// Next roulette song. Never one that is queued/playing or was played in the last 18 hours.
// With requests from the last 48 hours it follows their artists/genres/channels; with none
// it falls back to the most-viewed songs of the all-time top genre.
function pickRoulette(entries, { taste, exclude = new Set(), recentlyPlayed = new Set(), genre = null, random = Math.random }) {
  const pool = entries.filter((e) => e.isSong && !exclude.has(e.videoId) && !recentlyPlayed.has(e.videoId));
  if (!pool.length) return null;
  const choose = (arr, n) => arr[Math.min(Math.min(n, arr.length) - 1, Math.floor(random() * Math.min(n, arr.length)))];
  if (taste && taste.total) {
    const fits = pool
      .filter((e) => relevant(e, taste))
      .map((e) => ({ e, s: scoreEntry(e, taste) }))
      .sort((a, b) => b.s - a.s);
    if (fits.length) return choose(fits, 8).e;
  }
  let base = genre ? pool.filter((e) => e.genre === genre) : pool;
  if (base.length < 3) base = pool;
  base = base.slice().sort((a, b) => b.views - a.views);
  return choose(base, 12);
}

// ---------- funny "up next" messages ----------
const HEADLINES = {
  singer: [
    'Up next: {singer} with “{title}”! Give it up for {singer}! 🎉',
    '{singer}, your moment has arrived. “{title}” is loaded and the room is ready. 🎤',
    'Warm up those vocal cords, {singer}. “{title}” is coming up!',
    'Plot twist: {singer} is up next with “{title}”. No pressure. (A little pressure.) 😅',
    'Hide the earplugs… just kidding! {singer} is about to crush “{title}”. 🔥',
  ],
  roulette: [
    'Nobody grabbed the mic, so the Roulette gods picked “{title}”. Someone sing it! 🎲',
    '🎲 Roulette rolled: “{title}”. First brave soul to claim it wins eternal glory.',
    'The wheel has spoken: “{title}”. Tap it in the app to claim it as yours!',
  ],
  open: [
    '“{title}” is up for grabs! Whoever claims it first owns the mic. 🎤',
    'The host picked “{title}” and it needs a singer. Any volunteers? 👀',
  ],
};
const TEASES = {
  artist: [
    '{name}, we noticed you like {artist}. Might we suggest “{rec}”? 🎤',
    'Hey {name}! Your {artist} era isn’t complete until you’ve sung “{rec}”.',
    '{name} + {artist} = true love. Next date: “{rec}”. 💘',
  ],
  genre: [
    '{name} has been on a {genre} streak. “{rec}” would fit right in. Don’t make us come get you.',
    'Rumor has it {name} has one more {genre} banger in them: “{rec}”. 👀',
  ],
  plain: [
    '{name}, you’ve got that “one more song” look. Try “{rec}”!',
    'Calling {name}! The Recommended list has a song with your name on it: “{rec}”. 🎶',
  ],
  none: [
    'Anyone brave enough? The queue has room, and the crowd is warmed up. 🎶',
    'Shy singers: the mic doesn’t bite. Scan the QR code and add a song!',
  ],
};

function fill(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k])));
}

/**
 * next: { singer, title, kind: 'singer'|'roulette'|'open' } or null
 * people: [{ name, requests: [...] }]   everyone who requested a song in the last 48 hours
 * recFor(requests, excludeName) -> catalog entry | null   a recommendation for that person
 */
function composeMessage({ next, people = [], recFor = () => null, random = Math.random }) {
  const pick = (arr) => arr[Math.min(arr.length - 1, Math.floor(random() * arr.length))];
  let headline = null;
  if (next) headline = fill(pick(HEADLINES[next.kind] || HEADLINES.singer), { singer: next.singer, title: next.title });

  const others = people.filter((p) => !next || next.kind !== 'singer' || p.name.toLowerCase() !== String(next.singer).toLowerCase());
  const candidates = (others.length ? others : people).filter((p) => p.requests.length);
  let tease = null;
  let rec = null;
  let name = null;
  if (candidates.length) {
    const person = pick(candidates);
    const entry = recFor(person.requests);
    name = person.name;
    if (entry) {
      rec = { videoId: entry.videoId, title: entry.song || entry.title };
      const taste = buildTaste(person.requests);
      const topArtist = [...taste.artists.entries()].sort((a, b) => b[1] - a[1])[0];
      const topGenre = [...taste.genres.entries()].sort((a, b) => b[1] - a[1])[0];
      const lastArtist = person.requests.slice().reverse().find((r) => r.artist);
      let kind = 'plain';
      const vars = { name: person.name, rec: rec.title };
      if (topArtist && lastArtist) { kind = 'artist'; vars.artist = lastArtist.artist; }
      else if (topGenre) { kind = 'genre'; vars.genre = topGenre[0]; }
      tease = fill(pick(TEASES[kind]), vars);
    }
  }
  if (!tease) tease = pick(TEASES.none);
  return { headline, tease, name, rec };
}

module.exports = { HOUR, buildTaste, scoreEntry, recommend, pickRoulette, composeMessage };
