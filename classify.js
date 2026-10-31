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
const BACKING = /\b(backing|backup|background)\s*(vocals?|singers?|vox)\b|\bbvs?\b/i;
const NO_BACKING = /\b(no|without|minus|w\/o)\s+(the\s+)?((backing|backup|background)\s*(vocals?|singers?|vox)|bvs?)\b/i;
const NO_LYRICS = /\b(no|without|minus|w\/o)\s+lyrics\b/i;

/**
 * Decide whether a YouTube video looks like a karaoke track with on-screen
 * lyrics AND backing vocals. YouTube exposes no flag for this, so the check
 * reads the title and channel name:
 *
 *   accept - says karaoke and mentions backing/backup vocals
 *   review - says karaoke (or comes from a trusted karaoke channel) but never
 *            mentions backing vocals; the host decides (rejected in strict mode)
 *   reject - not karaoke, or explicitly "no backing vocals" / "no lyrics"
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
    return { result: 'reject', reason: "That doesn't look like a karaoke track. Search for the song plus “karaoke with lyrics and backing vocals”." };
  }
  if (NO_BACKING.test(text)) {
    return { result: 'reject', reason: 'That version has no backing vocals. Please pick one that does.' };
  }
  if (NO_LYRICS.test(text)) {
    return { result: 'reject', reason: 'That version has no on-screen lyrics. Please pick one that does.' };
  }
  if (BACKING.test(text)) {
    return { result: 'accept', reason: 'Karaoke track with backing vocals.' };
  }
  if (strict) {
    return { result: 'reject', reason: "The title doesn't say it has backing vocals. Look for a version that says “with backing vocals”." };
  }
  return { result: 'review', reason: "The title doesn't say it has backing vocals, so the host will check it." };
}

module.exports = { parseVideoId, classify };
