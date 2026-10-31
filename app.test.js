'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, parseVideoId } = require('./classify');
const { createApp } = require('./server');

test('parseVideoId handles common link shapes', () => {
  const id = 'xnFF5d7sOq4';
  assert.equal(parseVideoId('https://youtu.be/xnFF5d7sOq4?si=x8as6oh4EoWl7z2R'), id);
  assert.equal(parseVideoId('https://www.youtube.com/watch?v=xnFF5d7sOq4&t=30s'), id);
  assert.equal(parseVideoId('https://m.youtube.com/watch?v=xnFF5d7sOq4'), id);
  assert.equal(parseVideoId('https://music.youtube.com/watch?v=xnFF5d7sOq4'), id);
  assert.equal(parseVideoId('youtube.com/shorts/xnFF5d7sOq4'), id);
  assert.equal(parseVideoId('https://www.youtube.com/embed/xnFF5d7sOq4'), id);
  assert.equal(parseVideoId(id), id);
  assert.equal(parseVideoId('https://example.com/watch?v=xnFF5d7sOq4'), null);
  assert.equal(parseVideoId('https://www.youtube.com/playlist?list=PL123'), null);
  assert.equal(parseVideoId('hello'), null);
});

test('classify: lyrics + backing vocals accepted, others held or rejected', () => {
  const trusted = ['Sing King'];
  const c = (title, author = 'Some Channel', o = {}) => classify({ title, author }, { trusted, ...o }).result;

  assert.equal(c('Adele - Rolling in the Deep (Karaoke Version with Backing Vocals)'), 'accept');
  assert.equal(c('Queen - Bohemian Rhapsody (Karaoke with Lyrics & Backup Vocals)'), 'accept');
  assert.equal(c('Abba - Dancing Queen | Karaoke Backing Vocals'), 'accept');

  assert.equal(c('Queen - Bohemian Rhapsody (Karaoke Version)'), 'review');
  assert.equal(c('Queen - Bohemian Rhapsody', 'Sing King'), 'review');
  assert.equal(c('Queen - Bohemian Rhapsody (Karaoke Version)', 'x', { strict: true }), 'reject');

  assert.equal(c('Taylor Swift - Shake It Off (Official Music Video)'), 'reject');
  assert.equal(c('Taylor Swift - Shake It Off (Lyric Video)'), 'reject');
  assert.equal(c('Adele - Hello (Karaoke, no backing vocals)'), 'reject');
  assert.equal(c('Adele - Hello (Karaoke Version without Backup Vocals)'), 'reject');
  assert.equal(c('Adele - Hello (Karaoke - no lyrics, backing vocals)'), 'reject');
});

// ---- API ----
const META = {
  aaaaaaaaaa1: { title: 'Adele - Hello (Karaoke Version with Backing Vocals)', author: 'KaraokeCo' },
  aaaaaaaaaa2: { title: 'Queen - Bohemian Rhapsody (Karaoke Version)', author: 'KaraokeCo' },
  aaaaaaaaaa3: { title: 'Taylor Swift - Shake It Off (Official Video)', author: 'Taylor Swift' },
  aaaaaaaaaa4: { title: 'ABBA - Dancing Queen (Karaoke with Backing Vocals)', author: 'KaraokeCo' },
  aaaaaaaaaa5: { title: 'Journey - Don\'t Stop Believin\' (Karaoke with Backing Vocals)', author: 'KaraokeCo' },
  aaaaaaaaaa6: { title: 'Prince - Kiss (Karaoke with Backup Vocals)', author: 'KaraokeCo' },
};

async function boot(extra = {}) {
  const { app, cfg, state } = createApp({
    dataFile: null,
    hostKey: 'secret',
    maxPerSinger: 2,
    fetchMeta: async (id) => {
      if (!META[id]) { const e = new Error('Couldn\'t find that video.'); e.status = 422; throw e; }
      return META[id];
    },
    ...extra,
  });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, headers = {} } = {}) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null), text: null };
  };
  const host = { 'x-host-key': 'secret' };
  return { server, call, host, cfg, state, base };
}
const link = (id) => `https://youtu.be/${id}`;

test('API: add, review, reject, duplicates, limits', async () => {
  const { server, call } = await boot();
  try {
    let r = await call('/api/queue', { method: 'POST', body: { singer: 'Ann', url: link('aaaaaaaaaa1') } });
    assert.equal(r.status, 201);
    assert.equal(r.json.item.status, 'queued');
    assert.ok(r.json.token);
    assert.equal(r.json.item.token, undefined, 'token must not be public');

    r = await call('/api/queue', { method: 'POST', body: { singer: 'Ben', url: link('aaaaaaaaaa2') } });
    assert.equal(r.status, 201);
    assert.equal(r.json.item.status, 'review');

    r = await call('/api/queue', { method: 'POST', body: { singer: 'Cy', url: link('aaaaaaaaaa3') } });
    assert.equal(r.status, 422);

    r = await call('/api/queue', { method: 'POST', body: { singer: 'Cy', url: link('aaaaaaaaaa1') } });
    assert.equal(r.status, 409);

    r = await call('/api/queue', { method: 'POST', body: { singer: '', url: link('aaaaaaaaaa4') } });
    assert.equal(r.status, 400);

    r = await call('/api/queue', { method: 'POST', body: { singer: 'Cy', url: 'not a link' } });
    assert.equal(r.status, 400);

    // per-singer cap of 2 (Ann already has 1)
    r = await call('/api/queue', { method: 'POST', body: { singer: 'ann', url: link('aaaaaaaaaa4') } });
    assert.equal(r.status, 201);
    r = await call('/api/queue', { method: 'POST', body: { singer: 'ANN', url: link('aaaaaaaaaa5') } });
    assert.equal(r.status, 429);

    r = await call('/api/state');
    assert.equal(r.json.upcoming.length, 2);
    assert.equal(r.json.review.length, 1);
  } finally { server.close(); }
});

test('API: fair rotation, play next, approve, expectId, remove', async () => {
  const { server, call, host } = await boot({ maxPerSinger: 5 });
  try {
    const add = (singer, id) => call('/api/queue', { method: 'POST', body: { singer, url: link(id) } });
    await add('Ann', 'aaaaaaaaaa1');
    await add('Ann', 'aaaaaaaaaa4');
    const ben = await add('Ben', 'aaaaaaaaaa5');
    await add('Ann', 'aaaaaaaaaa6');

    let s = (await call('/api/state')).json;
    // Ann1, Ben1, Ann2, Ann3
    assert.deepEqual(s.upcoming.map((x) => x.singer), ['Ann', 'Ben', 'Ann', 'Ann']);

    // host actions need the key
    assert.equal((await call('/api/host/next', { method: 'POST', body: {} })).status, 401);

    // approve a held song
    const held = await add('Cy', 'aaaaaaaaaa2');
    assert.equal((await call('/api/host/approve/' + held.json.item.id, { method: 'POST', headers: host })).status, 200);

    // advance; expectId guards against a double advance
    s = (await call('/api/host/next', { method: 'POST', headers: host, body: { expectId: null } })).json;
    assert.equal(s.nowPlaying.videoId, 'aaaaaaaaaa1');
    const first = s.nowPlaying.id;
    await call('/api/host/next', { method: 'POST', headers: host, body: { expectId: null } }); // stale, ignored
    s = (await call('/api/state')).json;
    assert.equal(s.nowPlaying.id, first);

    // play next jumps the line
    const last = s.upcoming[s.upcoming.length - 1];
    await call('/api/host/playnext/' + last.id, { method: 'POST', headers: host });
    s = (await call('/api/host/next', { method: 'POST', headers: host, body: { expectId: first } })).json;
    assert.equal(s.nowPlaying.id, last.id);

    // guest removal needs their own token; host can remove anything
    let r = await call('/api/queue/' + ben.json.item.id, { method: 'DELETE' });
    assert.equal(r.status, 403);
    r = await call('/api/queue/' + ben.json.item.id, { method: 'DELETE', headers: { 'x-owner-token': ben.json.token } });
    assert.equal(r.status, 200);
    s = (await call('/api/state')).json;
    const victim = s.upcoming[0];
    r = await call('/api/queue/' + victim.id, { method: 'DELETE', headers: host });
    assert.equal(r.status, 200);
  } finally { server.close(); }
});

test('strict mode rejects unclear titles; QR and pages are served', async () => {
  const { server, call, base } = await boot({ strict: true, publicUrl: 'https://karaoke.example.com' });
  try {
    const r = await call('/api/queue', { method: 'POST', body: { singer: 'Ben', url: link('aaaaaaaaaa2') } });
    assert.equal(r.status, 422);

    const qr = await fetch(base + '/qr.svg');
    assert.equal(qr.status, 200);
    assert.match(qr.headers.get('content-type'), /svg/);
    assert.match(await qr.text(), /<svg/);

    assert.equal((await call('/api/join')).json.url, 'https://karaoke.example.com');
    assert.equal((await fetch(base + '/')).status, 200);
    assert.equal((await fetch(base + '/host')).status, 200);
    assert.equal((await fetch(base + '/style.css')).status, 200);
    assert.equal((await fetch(base + '/server.js')).status, 404, 'source must not be served');
    assert.equal((await fetch(base + '/package.json')).status, 404);
  } finally { server.close(); }
});

test('search: karaoke-only results, query is steered, tap-to-add by videoId', async () => {
  const queries = [];
  const raw = [
    { videoId: 'bbbbbbbbbb1', title: 'Adele - Hello (Official Music Video)', author: 'Adele' },
    { videoId: 'bbbbbbbbbb2', title: "Adele - Hello (Karaoke Version)", author: 'KaraokeCo' },
    { videoId: 'bbbbbbbbbb3', title: "Adele - Hello (Karaoke with Backing Vocals & Lyrics)", author: 'KaraokeCo' },
    { videoId: 'bbbbbbbbbb4', title: 'Adele - Hello (Karaoke, no backing vocals)', author: 'KaraokeCo' },
  ];
  META.bbbbbbbbbb3 = { title: raw[2].title, author: 'KaraokeCo' };
  const { server, call } = await boot({ search: async (q) => { queries.push(q); return raw; } });
  try {
    let r = await call('/api/search?q=a');
    assert.equal(r.status, 400);

    r = await call('/api/search?q=adele hello');
    assert.equal(r.status, 200);
    assert.match(queries[0], /adele hello karaoke with lyrics and backing vocals/);
    // official video and "no backing vocals" are dropped; accepted result sorts first
    assert.deepEqual(r.json.results.map((x) => x.videoId), ['bbbbbbbbbb3', 'bbbbbbbbbb2']);
    assert.deepEqual(r.json.results.map((x) => x.status), ['accept', 'review']);

    // cached: same query does not call the search function again
    await call('/api/search?q=ADELE hello');
    assert.equal(queries.length, 1);

    // tap-to-add sends only a videoId
    r = await call('/api/queue', { method: 'POST', body: { singer: 'Ann', videoId: 'bbbbbbbbbb3' } });
    assert.equal(r.status, 201);
    r = await call('/api/search?q=adele hello');
    assert.equal(r.json.results.find((x) => x.videoId === 'bbbbbbbbbb3').inQueue, true);
    assert.equal((await call('/api/state')).json.settings.searchEnabled, true);
  } finally { server.close(); }
});

test('search is reported off when no key or search function is configured', async () => {
  delete process.env.YOUTUBE_API_KEY;
  const { server, call } = await boot();
  try {
    const r = await call('/api/search?q=adele');
    assert.equal(r.status, 503);
    assert.equal((await call('/api/state')).json.settings.searchEnabled, false);
  } finally { server.close(); }
});
