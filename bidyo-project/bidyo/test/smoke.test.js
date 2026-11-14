'use strict';
// End-to-end smoke test: starts the server on a temp data dir and exercises auth, upload, streaming, limits.
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bidyo-test-'));
process.env.DATA_DIR = tmp;
process.env.DEV_RETURN_OTP = '1';
process.env.OTP_RESEND_SECONDS = '1';
process.env.PORT = '0';
process.env.MAX_UPLOAD_MB = '5';
delete process.env.SMTP_USER;

const { server } = require('../server');

const H = { 'X-Requested-With': 'bidyo' };
let base;
const j = (p, o = {}) => fetch(base + p, o);
const post = (p, body, cookie) => j(p, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// tiny fake mp4: valid "ftyp" box header followed by filler
const fakeMp4 = n => { const b = Buffer.alloc(n, 7); b.writeUInt32BE(24, 0); b.write('ftypisom', 4, 'latin1'); return b; };

async function login(email) {
  let r = await post('/api/auth/request-otp', { email });
  assert.equal(r.status, 200, 'request otp');
  const { devCode } = await r.json();
  assert.match(devCode, /^\d{6}$/);
  r = await post('/api/auth/verify-otp', { email, code: devCode });
  assert.equal(r.status, 200, 'verify otp');
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return { cookie, user: (await r.json()).user };
}

async function upload(cookie, qs, body) {
  return j('/api/videos?' + new URLSearchParams(qs), { method: 'POST', headers: { ...H, Cookie: cookie, 'Content-Type': 'video/mp4' }, body });
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('public browsing needs no login', async () => {
  assert.equal((await j('/')).status, 200);
  assert.equal((await j('/api/videos')).status, 200);
  assert.equal((await (await j('/api/me')).json()).user, null);
  assert.equal((await j('/api/config')).status, 200);
});
test('static path traversal blocked', async () => {
  const r = await j('/..%2f..%2fserver.js');
  assert.ok(!(await r.text()).includes('createServer'));
});
test('non-gmail rejected, bad code rejected, lockout after max attempts', async () => {
  assert.equal((await post('/api/auth/request-otp', { email: 'a@yahoo.com' })).status, 400);
  assert.equal((await post('/api/auth/request-otp', { email: 'nope' })).status, 400);
  const email = 'lock.test@gmail.com';
  const { devCode } = await (await post('/api/auth/request-otp', { email })).json();
  const wrong = devCode === '000000' ? '111111' : '000000';
  for (let i = 0; i < 4; i++) assert.equal((await post('/api/auth/verify-otp', { email, code: wrong })).status, 400);
  assert.equal((await post('/api/auth/verify-otp', { email, code: wrong })).status, 429);
  // even the right code no longer works after lockout
  assert.equal((await post('/api/auth/verify-otp', { email, code: devCode })).status, 400);
});
test('resend cooldown enforced', async () => {
  const email = 'cool.down@gmail.com';
  assert.equal((await post('/api/auth/request-otp', { email })).status, 200);
  assert.equal((await post('/api/auth/request-otp', { email })).status, 429);
  await sleep(1100);
  assert.equal((await post('/api/auth/request-otp', { email })).status, 200);
});
test('OTP is single use; dots/+tags map to one Gmail account', async () => {
  const a = await login('Jane.Doe+x@gmail.com');
  await sleep(1100);
  const b = await login('janedoe@gmail.com');
  assert.equal(a.user.id, b.user.id);
  const email = 'single.use@gmail.com';
  const { devCode } = await (await post('/api/auth/request-otp', { email })).json();
  assert.equal((await post('/api/auth/verify-otp', { email, code: devCode })).status, 200);
  assert.equal((await post('/api/auth/verify-otp', { email, code: devCode })).status, 400);
});
test('CSRF header required on POST', async () => {
  const r = await j('/api/auth/request-otp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"email":"x@gmail.com"}' });
  assert.equal(r.status, 403);
});
test('upload requires login', async () => {
  assert.equal((await upload('', { title: 't' }, fakeMp4(100))).status, 401);
});

let vid, owner, other;
test('upload, list, stream with Range, thumbnail, views', async () => {
  owner = await login('owner.one@gmail.com');
  const q = { title: 'Dancing in the rain', description: 'fun', category: 'Dance', visibility: 'public', status: 'published', filename: 'a.mp4', duration: '12.5', rights: '1' };
  // validation
  assert.equal((await upload(owner.cookie, { ...q, rights: '0' }, fakeMp4(500))).status, 400);
  assert.equal((await upload(owner.cookie, { ...q, filename: 'a.exe' }, fakeMp4(500))).status, 415);
  assert.equal((await upload(owner.cookie, q, Buffer.alloc(500, 1))).status, 415, 'magic bytes');
  assert.equal((await upload(owner.cookie, q, fakeMp4(6 * 1024 * 1024))).status, 413, 'too big');
  const r = await upload(owner.cookie, q, fakeMp4(200000));
  assert.equal(r.status, 201);
  vid = (await r.json()).video;
  const list = await (await j('/api/videos')).json();
  assert.equal(list.videos.length, 1);
  assert.equal(list.videos[0].creator.name, 'ownerone');
  // anonymous streaming with ranges
  let s = await j(`/api/videos/${vid.id}/stream`, { headers: { Range: 'bytes=100-199' } });
  assert.equal(s.status, 206);
  assert.equal(s.headers.get('content-range'), 'bytes 100-199/200000');
  assert.equal((await s.arrayBuffer()).byteLength, 100);
  s = await j(`/api/videos/${vid.id}/stream`, { headers: { Range: 'bytes=-50' } });
  assert.equal(s.status, 206); assert.equal((await s.arrayBuffer()).byteLength, 50);
  s = await j(`/api/videos/${vid.id}/stream`, { headers: { Range: 'bytes=999999-' } });
  assert.equal(s.status, 416);
  assert.equal((await j(`/api/videos/${vid.id}/stream`)).status, 200);
  // thumbnail
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)]);
  assert.equal((await j(`/api/videos/${vid.id}/thumb`, { method: 'PUT', headers: { ...H, Cookie: owner.cookie, 'Content-Type': 'image/jpeg' }, body: jpg })).status, 200);
  assert.equal((await j(`/api/videos/${vid.id}/thumb`)).status, 200);
  // views counted once per ip
  await post(`/api/videos/${vid.id}/view`, {}); await post(`/api/videos/${vid.id}/view`, {});
  assert.equal((await (await j(`/api/videos/${vid.id}`)).json()).video.views, 1);
});
test('search and category filter', async () => {
  assert.equal((await (await j('/api/videos?q=rain')).json()).videos.length, 1);
  assert.equal((await (await j('/api/videos?q=%25')).json()).videos.length, 0, 'wildcard escaped');
  assert.equal((await (await j('/api/videos?category=Comedy')).json()).videos.length, 0);
  assert.equal((await j('/api/videos?category=Nope')).status, 400);
});
test('drafts/private hidden from others, visible to owner; unlisted reachable by link only', async () => {
  other = await login('other.person@gmail.com');
  const mk = (extra) => upload(owner.cookie, { title: 'x', category: 'Food', filename: 'b.mp4', rights: '1', ...extra }, fakeMp4(2000));
  const draft = (await (await mk({ status: 'draft' })).json()).video;
  const priv = (await (await mk({ visibility: 'private' })).json()).video;
  const unl = (await (await mk({ visibility: 'unlisted' })).json()).video;
  const ids = (await (await j('/api/videos')).json()).videos.map(v => v.id);
  assert.deepEqual(ids, [vid.id], 'only the public published video in feed');
  for (const v of [draft, priv]) {
    assert.equal((await j(`/api/videos/${v.id}`)).status, 404);
    assert.equal((await j(`/api/videos/${v.id}/stream`, { headers: { Cookie: other.cookie } })).status, 404);
    assert.equal((await j(`/api/videos/${v.id}/stream`, { headers: { Cookie: owner.cookie } })).status, 200);
  }
  assert.equal((await j(`/api/videos/${unl.id}`)).status, 200);
  // others cannot modify/delete
  const del = await j(`/api/videos/${unl.id}`, { method: 'DELETE', headers: { ...H, Cookie: other.cookie } });
  assert.equal(del.status, 404);
  // owner publishes draft via PATCH
  const p = await j(`/api/videos/${draft.id}`, { method: 'PATCH', headers: { ...H, 'Content-Type': 'application/json', Cookie: owner.cookie }, body: JSON.stringify({ status: 'published' }) });
  assert.equal(p.status, 200);
  assert.equal((await (await j('/api/videos')).json()).videos.length, 2);
});
test('multiple users upload concurrently', async () => {
  const users = await Promise.all(['u1', 'u2', 'u3', 'u4', 'u5'].map(n => login(`${n}.multi@gmail.com`)));
  const rs = await Promise.all(users.map((u, i) => upload(u.cookie, { title: `vid ${i}`, category: 'Games', filename: 'c.mp4', rights: '1' }, fakeMp4(1_000_000))));
  assert.deepEqual(rs.map(r => r.status), [201, 201, 201, 201, 201]);
  const watchers = await Promise.all(Array.from({ length: 60 }, () => j('/api/videos?limit=5')));
  assert.ok(watchers.every(r => r.status === 200));
});
test('delete removes files; logout kills session', async () => {
  const files = fs.readdirSync(path.join(tmp, 'uploads')).filter(f => f.startsWith(vid.id));
  assert.ok(files.length >= 1);
  assert.equal((await j(`/api/videos/${vid.id}`, { method: 'DELETE', headers: { ...H, Cookie: owner.cookie } })).status, 200);
  await sleep(100);
  assert.equal(fs.readdirSync(path.join(tmp, 'uploads')).filter(f => f.startsWith(vid.id)).length, 0);
  assert.equal((await j(`/api/videos/${vid.id}`)).status, 404);
  await post('/api/auth/logout', {}, owner.cookie);
  assert.equal((await (await j('/api/me', { headers: { Cookie: owner.cookie } })).json()).user, null);
});

server.listen(0, '127.0.0.1', async () => {
  base = `http://127.0.0.1:${server.address().port}`;
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('  ok   ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e).split('\n').slice(0, 4).join('\n       ')); }
  }
  console.log(failed ? `\n${failed} failed` : '\nAll tests passed');
  server.close(); fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
});
