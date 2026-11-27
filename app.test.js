'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, parseVideoId, coverage, queryTokens, tokenize, parseSongTitle } = require('./classify');
const { createApp } = require('./server');

// ---------- text helpers ----------
test('parseVideoId handles common link shapes', () => {
  const id = 'xnFF5d7sOq4';
  assert.equal(parseVideoId('https://youtu.be/xnFF5d7sOq4?si=x8as6oh4EoWl7z2R'), id);
  assert.equal(parseVideoId('https://www.youtube.com/watch?v=xnFF5d7sOq4&t=30s'), id);
  assert.equal(parseVideoId('https://m.youtube.com/watch?v=xnFF5d7sOq4'), id);
  assert.equal(parseVideoId('youtube.com/shorts/xnFF5d7sOq4'), id);
  assert.equal(parseVideoId(id), id);
  assert.equal(parseVideoId('https://example.com/watch?v=xnFF5d7sOq4'), null);
  assert.equal(parseVideoId('hello'), null);
});

test('classify: lyrics + singer vocals accepted, instrumentals rejected', () => {
  const trusted = ['Sing King'];
  const c = (title, author = 'Some Channel', o = {}) => classify({ title, author }, { trusted, ...o }).result;
  assert.equal(c('Adele - Rolling in the Deep (Karaoke Version with Lead Vocals)'), 'accept');
  assert.equal(c('Abba - Dancing Queen | Sing Along Karaoke'), 'accept');
  assert.equal(c('Queen - Bohemian Rhapsody (Karaoke Version)'), 'review');
  assert.equal(c('Queen - Bohemian Rhapsody', 'Sing King'), 'review');
  assert.equal(c('Taylor Swift - Shake It Off (Official Music Video)'), 'reject');
  assert.equal(c('Adele - Hello (Karaoke Instrumental)'), 'reject');
  assert.equal(c('Adele - Hello (Karaoke with lead vocals, no lyrics)'), 'reject');
});

test('fuzzy matching and title parsing', () => {
  const t = tokenize('Adele - Hello (Karaoke with Lead Vocals)');
  assert.equal(coverage(queryTokens('adele'), t), 1);
  assert.equal(coverage(queryTokens('hellow'), t), 1, 'one typo is fine');
  assert.equal(coverage(queryTokens('adelle'), t), 1);
  assert.equal(coverage(queryTokens('adele hello'), t), 1);
  assert.equal(coverage(queryTokens('adele rolling'), t), 0.5);
  assert.equal(coverage(queryTokens('Beyoncé'), tokenize('Beyonce - Halo')), 1, 'accents ignored');
  const p = parseSongTitle("Journey - Don't Stop Believin' (Karaoke with Lead Vocals)");
  assert.equal(p.artist, 'Journey');
  assert.equal(p.song, "Don't Stop Believin'");
});

// ---------- fake YouTube ----------
const v = (videoId, title, views, genre = null) => ({ videoId, title, views, genre });
const CHANNELS = {
  '@alpha': {
    id: 'UCalpha', title: 'Alpha Karaoke', handle: 'alpha',
    videos: [
      v('pppppppppp1', 'Adele - Hello (Karaoke with Lead Vocals)', 1000, 'pop'),
      v('pppppppppp2', 'Adele - Rolling in the Deep (Karaoke with Lead Vocals)', 900, 'pop'),
      v('pppppppppp3', 'ABBA - Dancing Queen (Karaoke with Lead Vocals)', 800, 'pop'),
      v('pppppppppp4', 'Queen - Bohemian Rhapsody (Karaoke with Lead Vocals)', 700, 'rock'),
      v('pppppppppp5', 'Alpha Karaoke 3 hour non-stop compilation', 5000),
    ],
  },
  '@countryhype': {
    id: 'UCcountry', title: 'Country Hype', handle: 'countryhype',
    videos: [
      v('cccccccccc1', 'Luke Combs - Beautiful Crazy (Karaoke with Lead Vocals)', 500, 'country'),
      v('cccccccccc2', 'Chris Stapleton - Tennessee Whiskey (Karaoke with Lead Vocals)', 400, 'country'),
      v('cccccccccc3', 'Morgan Wallen - Last Night (Karaoke with Lead Vocals)', 300, 'country'),
      v('cccccccccc4', 'Luke Combs - Hurricane (Karaoke with Lead Vocals)', 200, 'country'),
    ],
  },
};
const META = {
  nnnnnnnnnn1: { title: 'Prince - Kiss (Karaoke with Guide Vocals)', author: 'OtherCo' },
  nnnnnnnnnn2: { title: 'Taylor Swift - Shake It Off (Official Video)', author: 'Taylor Swift' },
  nnnnnnnnnn3: { title: 'Toto - Africa (Karaoke Version)', author: 'OtherCo' },
};
const BROAD = (q) => [
  { videoId: 'nnnnnnnnnn1', title: META.nnnnnnnnnn1.title, author: 'OtherCo' },
  { videoId: 'nnnnnnnnnn2', title: META.nnnnnnnnnn2.title, author: 'Taylor Swift' },
  { videoId: 'nnnnnnnnnn3', title: META.nnnnnnnnnn3.title, author: 'OtherCo' },
  { videoId: 'pppppppppp3', title: 'ABBA - Dancing Queen (Karaoke with Lead Vocals)', author: 'Alpha Karaoke' },
];

async function boot(extra = {}) {
  const calls = { search: [], resolve: [] };
  const ctx = createApp({
    dataFile: null,
    quiet: true,
    channels: ['@alpha', '@countryhype'],
    hostKey: 'secret',
    maxPerSinger: 2,
    breakMs: 10000,
    random: () => 0,
    loadChannel: async (h) => { if (!CHANNELS[h]) throw new Error('nope'); return CHANNELS[h]; },
    fetchMeta: async (id) => {
      if (!META[id]) { const e = new Error("Couldn't find that video."); e.status = 422; throw e; }
      return META[id];
    },
    search: async (q, channelId) => { calls.search.push({ q, channelId }); return BROAD(q); },
    resolveChannel: async (h) => { calls.resolve.push(h); return { id: 'UC' + h, title: h }; },
    ...extra,
  });
  await ctx.catalog.ensure();
  await ctx.ensureRoulettePick();
  const server = await new Promise((r) => { const s = ctx.app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, headers = {} } = {}) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const host = { 'x-host-key': 'secret' };
  const add = (singer, videoId, extraBody = {}) => call('/api/queue', { method: 'POST', body: { singer, videoId, ...extraBody } });
  return { ...ctx, server, call, host, base, calls, add };
}
const ids = (list) => list.map((x) => x.videoId);

// ---------- search ----------
test('search: needs at least one field; any one field works', async () => {
  const { server, call } = await boot();
  try {
    let r = await call('/api/search');
    assert.equal(r.status, 400);
    assert.match(r.json.error, /at least one/i);
    r = await call('/api/search?artist=a');
    assert.equal(r.status, 400, 'one letter is not enough');

    r = await call('/api/search?artist=adele');
    assert.deepEqual(ids(r.json.results).slice(0, 2), ['pppppppppp1', 'pppppppppp2']);

    r = await call('/api/search?song=dancing%20queen');
    assert.equal(r.json.results[0].videoId, 'pppppppppp3');

    r = await call('/api/search?handle=%40countryhype');
    assert.deepEqual(ids(r.json.results).sort(), ['cccccccccc1', 'cccccccccc2', 'cccccccccc3', 'cccccccccc4']);
  } finally { server.close(); }
});

test('search: fields combine and closest match ranks first; typos tolerated', async () => {
  const { server, call } = await boot();
  try {
    let r = await call('/api/search?artist=luke%20combs&song=hurricane');
    assert.equal(r.json.results[0].videoId, 'cccccccccc4');
    assert.ok(!ids(r.json.results).includes('cccccccccc1'), 'song field must also match');

    r = await call('/api/search?artist=luke%20combs');
    assert.deepEqual(ids(r.json.results).slice(0, 2).sort(), ['cccccccccc1', 'cccccccccc4']);

    r = await call('/api/search?artist=adele&song=hellow');
    assert.equal(r.json.results[0].videoId, 'pppppppppp1');

    r = await call('/api/search?artist=adele&handle=countryhype');
    assert.equal(r.json.results.length, 0, 'handle narrows to that channel');
  } finally { server.close(); }
});

test('search: preferred first, other channels after, rejects dropped, other handle resolved', async () => {
  const { server, call, calls } = await boot();
  try {
    let r = await call('/api/search?song=zzzz%20nothing');
    const list = r.json.results;
    assert.deepEqual(list.map((x) => [x.videoId, x.preferred]), [['pppppppppp3', true], ['nnnnnnnnnn1', false], ['nnnnnnnnnn3', false], ['nnnnnnnnnn2', false]]);
    assert.equal(ids(list).at(-1), 'nnnnnnnnnn2', 'non-karaoke video is listed last');
    assert.match(calls.search[0].q, /karaoke with lyrics/);

    r = await call('/api/search?artist=prince&handle=@someotherchannel');
    assert.equal(calls.resolve[0], 'someotherchannel');
    assert.equal(calls.search.at(-1).channelId, 'UCsomeotherchannel');
    assert.ok(r.json.results.length > 0);
  } finally { server.close(); }
});

// ---------- adding ----------
test('add: preferred goes straight in; non-preferred needs a yes; rejects blocked', async () => {
  const { server, call, add, state } = await boot();
  try {
    let r = await add('Ann', 'pppppppppp1');
    assert.equal(r.status, 201);
    assert.equal(r.json.item.nonPreferred, false);
    assert.ok(r.json.token);
    assert.equal(r.json.item.token, undefined, 'token must not be public');

    r = await add('Ben', 'nnnnnnnnnn1');
    assert.equal(r.status, 409);
    assert.equal(r.json.needsConfirm, true);
    assert.match(r.json.error, /not a preferred video.*instrumental/i);
    assert.equal(state.queue.length, 1, 'nothing added without a yes');

    r = await add('Ben', 'nnnnnnnnnn1', { confirmNonPreferred: true });
    assert.equal(r.status, 201);
    assert.equal(r.json.item.nonPreferred, true);
    assert.equal(r.json.item.title.includes('Prince'), true);

    r = await add('Cat', 'nnnnnnnnnn2');
    assert.equal(r.status, 409, 'non-karaoke video still needs the yes');
    r = await add('Cat', 'nnnnnnnnnn2', { confirmNonPreferred: true });
    assert.equal(r.status, 201, 'with a yes, anything non-preferred can be added');

    r = await add('Ann', 'pppppppppp1');
    assert.equal(r.status, 409, 'duplicate');
    r = await add('Ann', 'pppppppppp2');
    r = await add('Ann', 'pppppppppp3');
    assert.equal(r.status, 429, 'limit of 2 each');
    r = await add('', 'pppppppppp4');
    assert.equal(r.status, 400);
    r = await call('/api/state');
    assert.ok(r.json.upcoming.find((s) => s.nonPreferred), 'host can see the non-preferred note');
  } finally { server.close(); }
});

test('a non-preferred song that plays all the way through makes its channel preferred', async () => {
  const { server, call, add, host } = await boot();
  try {
    await add('Ben', 'nnnnnnnnnn1', { confirmNonPreferred: true });
    await add('Cy', 'nnnnnnnnnn3', { confirmNonPreferred: true });
    await call('/api/host/start', { method: 'POST', headers: host, body: {} });
    // skipped: nothing changes
    let r = await call('/api/host/next', { method: 'POST', headers: host, body: { skip: true } });
    let s = await call('/api/search?song=zzzz%20nothing');
    assert.equal(s.json.results.find((x) => x.videoId === 'nnnnnnnnnn3').preferred, false);
    await call('/api/host/start', { method: 'POST', headers: host, body: { force: true } });
    // played to the end
    await call('/api/host/next', { method: 'POST', headers: host, body: { completed: true } });
    s = await call('/api/search?song=zzzz%20nothing');
    assert.equal(s.json.results.find((x) => x.videoId === 'nnnnnnnnnn1').preferred, true, 'same channel (OtherCo) is now preferred');
    r = await add('Dee', 'nnnnnnnnnn3');
    assert.equal(r.status, 201, 'no popup needed any more');
  } finally { server.close(); }
});

test('guests can remove only their own song; host can remove any', async () => {
  const { server, call, add, host } = await boot();
  try {
    const a = await add('Ann', 'pppppppppp1');
    const b = await add('Ben', 'pppppppppp2');
    let r = await call('/api/queue/' + a.json.item.id, { method: 'DELETE', headers: { 'x-owner-token': b.json.token } });
    assert.equal(r.status, 403);
    r = await call('/api/queue/' + a.json.item.id, { method: 'DELETE', headers: { 'x-owner-token': a.json.token } });
    assert.equal(r.status, 200);
    r = await call('/api/queue/' + b.json.item.id, { method: 'DELETE', headers: host });
    assert.equal(r.status, 200);
  } finally { server.close(); }
});

// ---------- playing: break, pause, restart ----------
test('host: 10-second break before every song, pause and restart', async () => {
  const { server, call, add, host } = await boot();
  try {
    await add('Ann', 'pppppppppp1');
    await add('Ben', 'pppppppppp2');

    // first song starts straight away
    let r = await call('/api/host/start', { method: 'POST', headers: host, body: {} });
    assert.equal(r.json.nowPlaying.singer, 'Ann');
    assert.equal(r.json.break, null);

    // pause / resume / restart
    r = await call('/api/host/pause', { method: 'POST', headers: host, body: { paused: true } });
    assert.equal(r.json.paused, true);
    const nonce = r.json.restartNonce;
    r = await call('/api/host/restart', { method: 'POST', headers: host, body: {} });
    assert.equal(r.json.restartNonce, nonce + 1);
    assert.equal(r.json.paused, false, 'restart resumes playback');
    r = await call('/api/host/pause', { method: 'POST', headers: host, body: {} });
    assert.equal(r.json.paused, true, 'no body toggles');

    // song ends: 10s break, then next one
    r = await call('/api/host/next', { method: 'POST', headers: host, body: {} });
    assert.equal(r.json.nowPlaying, null);
    assert.equal(r.json.paused, false);
    assert.ok(r.json.break);
    assert.equal(r.json.break.next.singer, 'Ben');
    const wait = r.json.break.until - r.json.serverNow;
    assert.ok(wait > 9000 && wait <= 10000, `break is 10s, was ${wait}`);
    assert.ok(r.json.break.message.headline.includes('Ben'));

    r = await call('/api/host/start', { method: 'POST', headers: host, body: {} });
    assert.equal(r.json.nowPlaying, null, 'too early: still on break');
    r = await call('/api/host/start', { method: 'POST', headers: host, body: { force: true } });
    assert.equal(r.json.nowPlaying.singer, 'Ben');
    assert.equal(r.json.break, null);

    r = await call('/api/host/pause', { method: 'POST', body: { paused: true } });
    assert.equal(r.status, 401);
  } finally { server.close(); }
});

test('host: break also separates roulette from the next queued song', async () => {
  const { server, call, add, host } = await boot();
  try {
    // nothing queued: start plays a roulette song
    let r = await call('/api/host/start', { method: 'POST', headers: host, body: {} });
    assert.equal(r.json.nowPlaying.roulette, true);
    await add('Ann', 'pppppppppp4');
    r = await call('/api/host/next', { method: 'POST', headers: host, body: {} });
    assert.ok(r.json.break, 'break between roulette and the queued song');
    assert.equal(r.json.break.next.singer, 'Ann');
  } finally { server.close(); }
});

test('breakMs 0 starts the next song immediately', async () => {
  const { server, call, add, host } = await boot({ breakMs: 0 });
  try {
    await add('Ann', 'pppppppppp1');
    await add('Ben', 'pppppppppp2');
    await call('/api/host/start', { method: 'POST', headers: host, body: {} });
    const r = await call('/api/host/next', { method: 'POST', headers: host, body: {} });
    assert.equal(r.json.nowPlaying.singer, 'Ben');
  } finally { server.close(); }
});

test('host: fair rotation, play next, skip for now', async () => {
  const { server, call, add, host } = await boot();
  try {
    await add('Ann', 'pppppppppp1');
    await add('Ann', 'pppppppppp2');
    await add('Ben', 'pppppppppp3');
    let r = await call('/api/state');
    assert.deepEqual(r.json.upcoming.map((s) => s.singer), ['Ann', 'Ben', 'Ann']);
    const ben = r.json.upcoming[1];
    await call('/api/host/playnext/' + ben.id, { method: 'POST', headers: host });
    r = await call('/api/state');
    assert.equal(r.json.upcoming[0].singer, 'Ben');
    r = await call('/api/host/defer/' + r.json.upcoming[0].id, { method: 'POST', headers: host });
    assert.equal(r.status, 200);
    r = await call('/api/state');
    assert.equal(r.json.upcoming[0].singer, 'Ann');
    assert.equal(r.json.upcoming[1].singer, 'Ben');
  } finally { server.close(); }
});

// ---------- roulette ----------
test('roulette: a pick is shown, guests can claim it, it goes to the bottom', async () => {
  const { server, call, add, host } = await boot();
  try {
    let r = await call('/api/state');
    const pick = r.json.roulettePick;
    assert.ok(pick, 'a roulette song is waiting');
    assert.equal(pick.singer, '🎲 Roulette');

    // queue empty: claimed song is next
    r = await call('/api/claim', { method: 'POST', body: { singer: 'Zed', id: pick.id } });
    assert.equal(r.status, 201);
    assert.ok(r.json.token);
    r = await call('/api/state');
    assert.deepEqual(r.json.upcoming.map((s) => s.singer), ['Zed']);
    assert.ok(r.json.roulettePick && r.json.roulettePick.id !== pick.id, 'a fresh roulette song takes its place');

    // with a queue: the claim lands at the bottom
    await add('Ann', 'pppppppppp1');
    await add('Ben', 'pppppppppp2');
    await add('Ann', 'pppppppppp3');
    r = await call('/api/state');
    r = await call('/api/claim', { method: 'POST', body: { singer: 'Cy', id: r.json.roulettePick.id } });
    assert.equal(r.status, 201);
    r = await call('/api/state');
    const order = r.json.upcoming.map((s) => s.singer);
    assert.equal(order.at(-1), 'Cy');

    r = await call('/api/claim', { method: 'POST', body: { singer: 'Dee', id: pick.id } });
    assert.equal(r.status, 409, 'already claimed');
    r = await call('/api/claim', { method: 'POST', body: { singer: '', id: 'x' } });
    assert.equal(r.status, 400);
  } finally { server.close(); }
});

test('roulette: never repeats a song played in the last 18 hours', async () => {
  let t = 1_000_000_000_000;
  const { server, call, host, state } = await boot({ now: () => t });
  try {
    const played = [];
    for (let i = 0; i < 20; i++) {
      let r = await call('/api/host/start', { method: 'POST', headers: host, body: {} });
      if (!r.json.nowPlaying) break;
      played.push(r.json.nowPlaying.videoId);
      r = await call('/api/host/next', { method: 'POST', headers: { ...host }, body: {} });
      await call('/api/host/start', { method: 'POST', headers: host, body: { force: true } });
      // next call plays the second song; put it back to idle for the loop
      const np = (await call('/api/state')).json.nowPlaying;
      if (np) played.push(np.videoId);
      await call('/api/host/next', { method: 'POST', headers: host, body: { expectId: np && np.id } });
    }
    assert.equal(new Set(played).size, played.length, 'no repeats within 18h: ' + played.join(','));
    assert.ok(played.length <= 8, 'only 8 real songs exist (the compilation is not a song)');
    assert.ok(!played.includes('pppppppppp5'), 'compilations are never roulette songs');

    // 19 hours later they are allowed again
    t += 19 * 3600 * 1000;
    state.roulettePick = null;
    state.break = null;
    state.nowPlaying = null;
    const r = await call('/api/host/start', { method: 'POST', headers: host, body: { force: true } });
    assert.ok(r.json.nowPlaying, 'songs are available again after 18 hours');
  } finally { server.close(); }
});

test('roulette: follows what was requested in the last 48 hours, falls back to the usual otherwise', async () => {
  const { server, call, add, host, state, ensureRoulettePick } = await boot();
  try {
    // no requests yet: most-viewed song of the top genre/overall (random() = 0 -> first)
    let r = await call('/api/state');
    assert.equal(r.json.roulettePick.videoId, 'pppppppppp1');

    // the room asks for country: roulette follows
    await add('Ann', 'cccccccccc1');
    state.roulettePick = null;
    await ensureRoulettePick();
    r = await call('/api/state');
    assert.ok(['cccccccccc4', 'cccccccccc2', 'cccccccccc3'].includes(r.json.roulettePick.videoId), 'country, and Luke Combs first: ' + r.json.roulettePick.videoId);
    assert.equal(r.json.roulettePick.videoId, 'cccccccccc4', 'same artist beats same genre');

    // 3 days later those requests no longer count
    for (const q of state.requests) q.at -= 72 * 3600 * 1000;
    state.roulettePick = null;
    await ensureRoulettePick();
    r = await call('/api/state');
    assert.equal(r.json.roulettePick.videoId, 'pppppppppp1');
  } finally { server.close(); }
});

test('roulette: host can shuffle and turn it off', async () => {
  const { server, call, host } = await boot();
  try {
    const before = (await call('/api/state')).json.roulettePick.videoId;
    let r = await call('/api/host/roulette', { method: 'POST', headers: host, body: { action: 'shuffle' } });
    assert.notEqual(r.json.roulettePick.videoId, before);
    r = await call('/api/host/roulette', { method: 'POST', headers: host, body: { action: 'off' } });
    assert.equal(r.json.roulettePick, null);
    r = await call('/api/host/start', { method: 'POST', headers: host, body: {} });
    assert.equal(r.json.nowPlaying, null, 'nothing plays when the queue is empty and roulette is off');
    r = await call('/api/host/roulette', { method: 'POST', headers: host, body: { action: 'on' } });
    assert.ok(r.json.roulettePick);
  } finally { server.close(); }
});

// ---------- Top 25 and recommendations ----------
test('discover: top songs are real requests only; recommendations need recent requests', async () => {
  const { server, call, add, state, host } = await boot();
  try {
    let r = await call('/api/discover');
    assert.deepEqual(r.json.top, [], 'nothing requested: nothing listed');
    assert.deepEqual(r.json.recommended, [], 'no requests: blank');

    await add('Ann', 'pppppppppp1');
    await add('Ben', 'pppppppppp1').catch(() => {});   // duplicate while queued, refused
    // play and finish it so it can be requested again
    await call('/api/host/start', { method: 'POST', headers: host, body: {} });
    await call('/api/host/next', { method: 'POST', headers: host, body: {} });
    await add('Ben', 'pppppppppp1');
    await add('Cy', 'cccccccccc2');

    r = await call('/api/discover');
    assert.equal(r.json.top.length, 2, 'only songs that were requested, no filler');
    assert.equal(r.json.top[0].videoId, 'pppppppppp1');
    assert.equal(r.json.top[0].count, 2);

    // recommendations: more by the requested artists / channel; not songs already requested
    assert.ok(r.json.recommended.length > 0);
    const rec = ids(r.json.recommended);
    assert.ok(rec.includes('pppppppppp2'), 'more Adele');
    assert.ok(rec.includes('cccccccccc1'), 'country, like Cy picked');
    assert.ok(!rec.includes('pppppppppp1') && !rec.includes('cccccccccc2'));
    assert.ok(!rec.includes('pppppppppp4') || rec.indexOf('pppppppppp4') > rec.indexOf('pppppppppp2'));

    // after 48 hours the list goes blank again, but the Top list stays
    for (const q of state.requests) q.at -= 49 * 3600 * 1000;
    r = await call('/api/discover');
    assert.deepEqual(r.json.recommended, []);
    assert.equal(r.json.top.length, 2);
  } finally { server.close(); }
});

test('discover: top list is capped at 25', async () => {
  const { server, call, state } = await boot();
  try {
    for (let i = 0; i < 40; i++) {
      const id = 'tttttttt' + String(i).padStart(3, '0');
      state.stats[id] = { videoId: id, title: 'Song ' + i, channel: 'x', count: i + 1, lastAt: i, preferred: true };
    }
    const r = await call('/api/discover');
    assert.equal(r.json.top.length, 25);
    assert.equal(r.json.top[0].count, 40);
  } finally { server.close(); }
});

// ---------- host tools ----------
test('host search, add to queue (named / open mic), add to roulette, recommendations', async () => {
  const { server, call, host, add } = await boot();
  try {
    let r = await call('/api/host/search?q=whiskey');
    assert.equal(r.status, 401);
    r = await call('/api/host/search?q=whiskey', { headers: host });
    assert.equal(r.json.results[0].videoId, 'cccccccccc2', 'free-text search matches titles');
    r = await call('/api/host/search?q=alpha%20karaoke%20bohemian', { headers: host });
    assert.equal(r.json.results[0].videoId, 'pppppppppp4', 'free text also matches the channel name');

    r = await call('/api/host/add', { method: 'POST', headers: host, body: { videoId: 'pppppppppp4', singer: 'Dad' } });
    assert.equal(r.status, 201);
    assert.equal(r.json.upcoming[0].singer, 'Dad');

    r = await call('/api/host/add', { method: 'POST', headers: host, body: { videoId: 'cccccccccc3', target: 'queue' } });
    const open = r.json.upcoming.find((s) => s.videoId === 'cccccccccc3');
    assert.equal(open.open, true);
    assert.equal(open.singer, '🎤 Open mic');
    r = await call('/api/claim', { method: 'POST', body: { singer: 'Eve', id: open.id } });
    assert.equal(r.status, 201);
    r = await call('/api/state');
    assert.equal(r.json.upcoming.find((s) => s.videoId === 'cccccccccc3').singer, 'Eve');

    r = await call('/api/host/add', { method: 'POST', headers: host, body: { videoId: 'pppppppppp2', target: 'roulette' } });
    assert.equal(r.json.roulettePick.videoId, 'pppppppppp2');

    // recommendations fit what is going on (three, one per artist)
    await add('Cy', 'cccccccccc1');
    r = await call('/api/host/recs', { headers: host });
    assert.ok(r.json.recs.length > 0 && r.json.recs.length <= 3);
    assert.equal(r.json.recs[0].videoId, 'cccccccccc4', 'same artist first');
  } finally { server.close(); }
});

test('up-next message names people from the last 48 hours and recommends a song', async () => {
  const { server, call, add, host, state } = await boot();
  try {
    await add('Ann', 'pppppppppp1');
    await add('Cy', 'cccccccccc1');
    await call('/api/host/start', { method: 'POST', headers: host, body: {} });
    const r = await call('/api/host/next', { method: 'POST', headers: host, body: {} });
    const m = r.json.break.message;
    assert.ok(m.headline.includes('Cy'), m.headline);
    assert.ok(m.tease && m.tease.length > 10);
    assert.ok(m.name, 'a person is called out');
    assert.ok(['Ann', 'Cy'].includes(m.name));
    assert.ok(m.rec && m.rec.videoId, 'with a suggested song');

    // people from more than 48 hours ago are not mentioned
    for (const q of state.requests) q.at -= 49 * 3600 * 1000;
    await call('/api/host/start', { method: 'POST', headers: host, body: { force: true } });
    const r2 = await call('/api/host/next', { method: 'POST', headers: host, body: {} });
    assert.equal(r2.json.break.message.name, null);
  } finally { server.close(); }
});

// ---------- setup ----------
test('preferred channel list: built-in handles plus extras, deduplicated', async () => {
  const saved = process.env.PREFERRED_CHANNELS;
  process.env.PREFERRED_CHANNELS = '@7CLOUDS, @someonenew';
  try {
    const { cfg } = createApp({ dataFile: null, quiet: true });
    assert.deepEqual(cfg.channels, ['@7clouds', '@melodymavel1', '@countryhype', '@Queenbee12234', '@oarmusic', '@phantomrecordsco', '@arms444and0', '@someonenew']);
    process.env.PREFERRED_CHANNELS = 'none';
    assert.deepEqual(createApp({ dataFile: null, quiet: true }).cfg.channels, []);
  } finally {
    if (saved === undefined) delete process.env.PREFERRED_CHANNELS; else process.env.PREFERRED_CHANNELS = saved;
  }
});

test('pages and host key', async () => {
  const { server, call, base } = await boot();
  try {
    for (const p of ['/', '/host', '/style.css']) assert.equal((await fetch(base + p)).status, 200);
    assert.equal((await fetch(base + '/server.js')).status, 404);
    assert.equal((await call('/api/host/check')).status, 401);
    assert.equal((await call('/api/host/check', { headers: { 'x-host-key': 'secret' } })).status, 200);
    const qr = await fetch(base + '/qr.svg');
    assert.match(await qr.text(), /<svg/);
  } finally { server.close(); }
});
