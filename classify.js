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
 *            says the singer is on it; the host decides (rejected in strict mode)
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
  return { result: 'review', reason: "The title doesn't say the singer's vocals are included, so the host will check it." };
}

module.exports = { parseVideoId, classify };
