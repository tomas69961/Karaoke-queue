'use strict';

// Pull an 11-character YouTube video id out of any common link shape.
function parseVideoId(input) {
  const raw = String(input || '').trim();
  if (/^[\w-]{11}$/.test(raw)) return raw;
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(www|m|music)\./i, '').toLowerCase();
  let id = null;
  if (host === 'youtu.be') {
    id = u.pathname.split('/')[1];
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else {
      const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/);
      if (m) id = m[1];
    }
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

const KARAOKE = /karaoke|sing[\s-]?along/i;
// Says the original singer's voice is on the track.
const WITH_SINGER = /\b(lead|guide|original|main)\s+(vocals?|voice|singer)\b|\bwith\s+(the\s+)?(original\s+)?(vocals?|singer|artist)\b|\bvocal\s+guide\b|\bguide\s+track\b|\bsing[\s-]?along\b/i;
// Says there is no singer, or it is an instrumental backing track.
const NO_SINGER = /\b(no|without|minus|w\/o)\s+(the\s+)?(lead\s+|main\s+|original\s+|guide\s+)?(vocals?|voice|singer)\b|\binstrumental\b|\bbacking\s+track\b/i;
const NO_LYRICS = /\b(no|without|minus|w\/o)\s+lyrics\b/i;

/**
 * Decide whether a YouTube video looks like a karaoke track with on-screen
 * lyrics AND the original singer's vocals playing along. YouTube exposes no
 * flag for this, so the check reads the title and channel name:
 *
 *   accept - says karaoke and mentions lead/guide/original vocals or the singer
 *   review - says karaoke (or comes from a trusted karaoke channel) but never
 *            says the singer is on it (rejected in strict mode)
 *   reject - not karaoke, or explicitly an instrumental / "no vocals" / "no lyrics"
 */
function classify(meta, { trusted = [], strict = false } = {}) {
  const title = String(meta.title || '');
  const author = String(meta.author || '');
  const text = `${title} ${author}`;
  const trustedChannel = trusted.some(
    (c) => c && author.toLowerCase().includes(c.trim().toLowerCase())
  );
  const looksKaraoke = KARAOKE.test(text) || trustedChannel;

  if (!looksKaraoke) {
    return { result: 'reject', reason: "That doesn't look like a karaoke track. Search for the song plus “karaoke with lyrics and lead vocals”." };
  }
  if (NO_SINGER.test(text)) {
    return { result: 'reject', reason: "That version is an instrumental with no singer's voice. Please pick one with lead or guide vocals." };
  }
  if (NO_LYRICS.test(text)) {
    return { result: 'reject', reason: 'That version has no on-screen lyrics. Please pick one that does.' };
  }
  if (WITH_SINGER.test(text)) {
    return { result: 'accept', reason: 'Karaoke track with lyrics and the singer’s vocals.' };
  }
  if (strict) {
    return { result: 'reject', reason: "The title doesn't say the singer's vocals are included. Look for a version that says “with lead vocals”." };
  }
  return { result: 'review', reason: "The title doesn't say the singer's vocals are included." };
}

// YouTube has no "genre" field. We read what it does give us: the video's topic
// categories (Wikipedia links like .../Pop_music) and its tags. Titles are
// ignored on purpose, since song names like "House of the Rising Sun" mislead.
const GENRE_BY_TOPIC = {
  Pop_music: 'pop', Rock_music: 'rock', Hip_hop_music: 'hip hop', Country_music: 'country',
  Electronic_music: 'dance', Rhythm_and_blues: 'r&b', Soul_music: 'r&b', Funk: 'r&b',
  Christian_music: 'gospel', Gospel_music: 'gospel', Reggae: 'reggae', Jazz: 'jazz',
  Music_of_Latin_America: 'latin', Heavy_metal_music: 'metal', Disco: 'disco',
};
const GENRE_TAGS = [
  ['hip hop', /\b(hip[\s-]?hop|rap)\b/i], ['r&b', /\b(r&b|rnb|rhythm and blues|soul)\b/i],
  ['country', /\bcountry\b/i], ['metal', /\bmetal\b/i], ['rock', /\b(rock|grunge|punk)\b/i],
  ['latin', /\b(latin|reggaeton|salsa|bachata)\b/i], ['disco', /\bdisco\b/i],
  ['dance', /\b(edm|dance|techno)\b/i], ['gospel', /\b(gospel|christian|worship)\b/i],
  ['reggae', /\breggae\b/i], ['jazz', /\bjazz\b/i], ['pop', /\bpop\b/i],
  ['80s', /\b(80s|1980s|eighties)\b/i], ['90s', /\b(90s|1990s|nineties)\b/i], ['2000s', /\b(2000s|00s)\b/i],
];
function inferGenre({ topics = [], tags = [] } = {}) {
  for (const t of topics) {
    const g = GENRE_BY_TOPIC[String(t).split('/').pop()];
    if (g) return g;
  }
  const text = tags.join(' | ');
  for (const [g, re] of GENRE_TAGS) if (re.test(text)) return g;
  return null;
}

// ---------- text matching (search fields, artists, recommendations) ----------

// Lowercase, strip accents, "&" -> "and", everything else that isn't a letter or
// digit becomes a space.
function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenize(s) {
  const n = normalizeText(s);
  return n ? n.split(' ') : [];
}

// Words that say nothing about WHICH song it is, so a search for "Adele Hello"
// is not held back because a title lacks the word "karaoke".
const STOP = new Set([
  'the', 'a', 'an', 'of', 'and', 'by', 'for', 'in', 'feat', 'ft', 'featuring',
  'karaoke', 'lyrics', 'lyric', 'version', 'with', 'vocals', 'vocal', 'lead', 'backing',
  'instrumental', 'official', 'video', 'audio', 'hd', 'hq', 'sing', 'along', 'track',
  'originally', 'performed', 'style',
]);
function queryTokens(s) {
  const all = tokenize(s);
  const kept = all.filter((t) => !STOP.has(t));
  return kept.length ? kept : all;
}

// True when two strings differ by at most one inserted, deleted or changed letter.
function withinOne(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (a.length < b.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

// A search word matches a title word if they are equal, one starts the other
// ("believ" ~ "believin"), or they are one typo apart ("helo" ~ "hello").
function tokenMatch(q, t) {
  if (q === t) return true;
  if (q.length >= 4 && t.length >= 4 && (t.startsWith(q) || q.startsWith(t))) return true;
  return q.length >= 5 && t.length >= 5 && withinOne(q, t);
}

// Fraction (0..1) of the search words found, fuzzily, among the title's words.
function coverage(qTokens, tokens) {
  if (!qTokens.length) return 1;
  let hit = 0;
  for (const q of qTokens) if (tokens.some((t) => tokenMatch(q, t))) hit++;
  return hit / qTokens.length;
}

// "ABBA - Dancing Queen (Karaoke with Lead Vocals)" -> { artist: 'ABBA', song: 'Dancing Queen' }.
// Best effort: most karaoke channels title videos "Artist - Song".
function parseSongTitle(title) {
  const t = String(title || '').replace(/\[[^\]]*\]|\([^)]*\)/g, ' ');
  const parts = t
    .split(/\s+[-–—]\s+|\s*\|\s*/)
    .map((p) => p.replace(/\b(karaoke|instrumental|lyrics?|sing[\s-]?along)\b.*$/i, '').trim())
    .filter(Boolean);
  let artist = '';
  let song = '';
  if (parts.length >= 2) { artist = parts[0]; song = parts[1]; }
  else if (parts.length === 1) song = parts[0];
  artist = artist.replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.*$/i, '').trim();
  return { artist, song, artistKey: normalizeText(artist), songKey: normalizeText(song) };
}

module.exports = {
  parseVideoId, classify, inferGenre,
  normalizeText, tokenize, queryTokens, tokenMatch, coverage, parseSongTitle,
};
