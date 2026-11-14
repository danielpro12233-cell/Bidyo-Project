'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const cfg = require('./lib/config');
const db = require('./lib/db');
const { sendOtp } = require('./lib/mailer');

/* ------------------------------------------------------------------ helpers */

const now = () => Date.now();
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const hmac = s => crypto.createHmac('sha256', cfg.APP_SECRET).update(s).digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }

function clientIp(req) {
  if (cfg.TRUST_PROXY) {
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function send(res, status, body, headers = {}) {
  const isObj = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
  const data = isObj ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

async function readJson(req, limit = 10 * 1024) {
  const ct = req.headers['content-type'] || '';
  if (!ct.includes('application/json')) throw new HttpError(415, 'Expected JSON');
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw new HttpError(413, 'Body too large'); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw new HttpError(400, 'Invalid JSON'); }
}

/* Simple fixed-window in-memory rate limiter (per process). */
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const t = now();
  let b = buckets.get(key);
  if (!b || b.reset <= t) { b = { n: 0, reset: t + windowMs }; buckets.set(key, b); }
  b.n++;
  if (b.n > max) throw new HttpError(429, 'Too many requests. Please slow down.', { retryAfter: Math.ceil((b.reset - t) / 1000) });
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/* ------------------------------------------------------------------ auth */

const SESSION_COOKIE = 'bidyo_sid';
const q = {
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  insertUser: db.prepare('INSERT INTO users (email, name, created_at) VALUES (?, ?, ?)'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  getOtp: db.prepare('SELECT * FROM otps WHERE email = ?'),
  upsertOtp: db.prepare(`INSERT INTO otps (email, code_hash, expires_at, attempts, last_sent_at, window_start, send_count)
                         VALUES (@email, @code_hash, @expires_at, 0, @last_sent_at, @window_start, @send_count)
                         ON CONFLICT(email) DO UPDATE SET code_hash=@code_hash, expires_at=@expires_at, attempts=0,
                         last_sent_at=@last_sent_at, window_start=@window_start, send_count=@send_count`),
  bumpAttempts: db.prepare('UPDATE otps SET attempts = attempts + 1 WHERE email = ?'),
  delOtp: db.prepare('DELETE FROM otps WHERE email = ?'),
  insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'),
  getSession: db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`),
  delSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
  purgeOtps: db.prepare('DELETE FROM otps WHERE expires_at <= ? AND last_sent_at <= ?'),
};

function currentUser(req) {
  const tok = parseCookies(req)[SESSION_COOKIE];
  if (!tok) return null;
  return q.getSession.get(sha256(tok), now()) || null;
}
function requireUser(req) {
  const u = currentUser(req);
  if (!u) throw new HttpError(401, 'Please sign in to upload.');
  return u;
}
function publicUser(u) {
  return { id: u.id, name: u.name, initial: (u.name[0] || '?').toUpperCase(), email: maskEmail(u.email) };
}
function maskEmail(e) {
  const [l, d] = e.split('@');
  return `${l[0]}${'•'.repeat(Math.max(2, Math.min(6, l.length - 1)))}@${d}`;
}

function normalizeEmail(raw) {
  const e = String(raw || '').trim().toLowerCase();
  if (e.length > 254 || !/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e)) throw new HttpError(400, 'Please enter a valid Gmail address.');
  const domain = e.split('@')[1];
  if (!cfg.ALLOWED_EMAIL_DOMAINS.includes(domain)) throw new HttpError(400, 'Please use a Gmail address (name@gmail.com).');
  // Gmail ignores dots and +tags: normalise so one person = one account.
  let [local] = e.split('@');
  local = local.split('+')[0].replace(/\./g, '');
  if (!local) throw new HttpError(400, 'Please enter a valid Gmail address.');
  return `${local}@gmail.com`;
}

function setSessionCookie(res, token, maxAgeSec) {
  const parts = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (cfg.COOKIE_SECURE) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

async function requestOtp(req, res) {
  const ip = clientIp(req);
  rateLimit(`otp-ip:${ip}`, 20, 3600 * 1000);
  const body = await readJson(req);
  const email = normalizeEmail(body.email);
  const t = now();
  const prev = q.getOtp.get(email);
  let windowStart = t, sendCount = 1;
  if (prev) {
    if (t - prev.last_sent_at < cfg.OTP_RESEND_MS) {
      const wait = Math.ceil((cfg.OTP_RESEND_MS - (t - prev.last_sent_at)) / 1000);
      throw new HttpError(429, `Please wait ${wait}s before requesting another code.`, { retryAfter: wait });
    }
    if (t - prev.window_start < 3600 * 1000) {
      if (prev.send_count >= cfg.OTP_MAX_PER_HOUR) throw new HttpError(429, 'Too many codes requested. Try again in a while.', { retryAfter: 3600 });
      windowStart = prev.window_start; sendCount = prev.send_count + 1;
    }
  }
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  q.upsertOtp.run({ email, code_hash: hmac(`${email}:${code}`), expires_at: t + cfg.OTP_TTL_MS, last_sent_at: t, window_start: windowStart, send_count: sendCount });
  try {
    await sendOtp(email, code);
  } catch (err) {
    console.error('[mail] failed:', err.message);
    q.delOtp.run(email);
    throw new HttpError(502, "We couldn't send the email right now. Please try again shortly.");
  }
  const out = { ok: true, email: maskEmail(email), expiresIn: Math.round(cfg.OTP_TTL_MS / 1000), resendIn: Math.round(cfg.OTP_RESEND_MS / 1000) };
  if (cfg.DEV_RETURN_OTP) out.devCode = code; // only when DEV_RETURN_OTP=1 and not production
  send(res, 200, out);
}

async function verifyOtp(req, res) {
  const ip = clientIp(req);
  rateLimit(`verify-ip:${ip}`, 60, 3600 * 1000);
  const body = await readJson(req);
  const email = normalizeEmail(body.email);
  const code = String(body.code || '').trim();
  if (!/^\d{6}$/.test(code)) throw new HttpError(400, 'Enter the 6-digit code.');
  const rec = q.getOtp.get(email);
  if (!rec || rec.expires_at <= now()) throw new HttpError(400, 'That code has expired. Please request a new one.', { code: 'expired' });
  if (rec.attempts >= cfg.OTP_MAX_ATTEMPTS) { q.delOtp.run(email); throw new HttpError(429, 'Too many wrong tries. Please request a new code.', { code: 'locked' }); }
  if (!safeEq(rec.code_hash, hmac(`${email}:${code}`))) {
    q.bumpAttempts.run(email);
    const left = cfg.OTP_MAX_ATTEMPTS - rec.attempts - 1;
    if (left <= 0) { q.delOtp.run(email); throw new HttpError(429, 'Too many wrong tries. Please request a new code.', { code: 'locked' }); }
    throw new HttpError(400, `Wrong code. ${left} ${left === 1 ? 'try' : 'tries'} left.`, { triesLeft: left });
  }
  q.delOtp.run(email); // single use

  let user = q.userByEmail.get(email);
  if (!user) {
    const name = email.split('@')[0];
    q.insertUser.run(email, name, now());
    user = q.userByEmail.get(email);
  }
  const token = crypto.randomBytes(32).toString('base64url');
  q.insertSession.run(sha256(token), user.id, now(), now() + cfg.SESSION_TTL_MS);
  setSessionCookie(res, token, Math.floor(cfg.SESSION_TTL_MS / 1000));
  send(res, 200, { ok: true, user: publicUser(user) });
}

/* ------------------------------------------------------------------ videos */

const v = {
  insert: db.prepare(`INSERT INTO videos (id, user_id, title, description, category, visibility, status, file, mime, size, duration, created_at)
                      VALUES (@id, @user_id, @title, @description, @category, @visibility, @status, @file, @mime, @size, @duration, @created_at)`),
  get: db.prepare('SELECT v.*, u.name AS creator FROM videos v JOIN users u ON u.id = v.user_id WHERE v.id = ?'),
  mine: db.prepare('SELECT v.*, u.name AS creator FROM videos v JOIN users u ON u.id = v.user_id WHERE v.user_id = ? ORDER BY v.created_at DESC'),
  countMine: db.prepare('SELECT COUNT(*) AS n FROM videos WHERE user_id = ?'),
  del: db.prepare('DELETE FROM videos WHERE id = ?'),
  view: db.prepare('UPDATE videos SET views = views + 1 WHERE id = ?'),
  setThumb: db.prepare('UPDATE videos SET has_thumb = 1 WHERE id = ?'),
};

const VISIBILITIES = ['public', 'unlisted', 'private'];
const STATUSES = ['published', 'draft'];

function videoJson(r, viewer) {
  const mine = viewer && viewer.id === r.user_id;
  return {
    id: r.id, title: r.title, description: r.description, category: r.category,
    duration: r.duration, views: r.views, createdAt: r.created_at, hasThumb: !!r.has_thumb,
    creator: { name: r.creator, initial: (r.creator[0] || '?').toUpperCase() },
    ...(mine ? { visibility: r.visibility, status: r.status, size: r.size, mine: true } : {}),
  };
}
function canView(r, viewer) {
  if (!r) return false;
  if (viewer && viewer.id === r.user_id) return true;
  return r.status === 'published' && (r.visibility === 'public' || r.visibility === 'unlisted');
}
function getVideoFor(id, viewer) {
  if (!/^[a-f0-9]{16}$/.test(id)) throw new HttpError(404, 'Video not found');
  const r = v.get.get(id);
  if (!canView(r, viewer)) throw new HttpError(404, 'Video not found');
  return r;
}

function listVideos(url, viewer, res) {
  const p = url.searchParams;
  const limit = Math.min(Math.max(parseInt(p.get('limit') || '60', 10) || 60, 1), 200);
  const offset = Math.max(parseInt(p.get('offset') || '0', 10) || 0, 0);
  const where = ["v.status = 'published'", "v.visibility = 'public'"];
  const args = [];
  const cat = p.get('category');
  if (cat) { if (!cfg.CATEGORIES.includes(cat)) throw new HttpError(400, 'Unknown category'); where.push('v.category = ?'); args.push(cat); }
  const text = (p.get('q') || '').trim().slice(0, 80);
  if (text) {
    const like = '%' + text.replace(/[\\%_]/g, m => '\\' + m) + '%';
    where.push("(v.title LIKE ? ESCAPE '\\' OR v.description LIKE ? ESCAPE '\\')"); args.push(like, like);
  }
  const order = p.get('sort') === 'new' ? 'v.created_at DESC' : 'v.views DESC, v.created_at DESC';
  const rows = db.prepare(`SELECT v.*, u.name AS creator FROM videos v JOIN users u ON u.id = v.user_id
                           WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, limit, offset);
  send(res, 200, { videos: rows.map(r => videoJson(r, viewer)) }, { 'Cache-Control': 'public, max-age=5' });
}

const activeUploads = new Map(); // userId -> count

function sniffVideo(buf) {
  if (buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp') return true;            // mp4 / mov / m4v
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return true; // webm / mkv
  return false;
}

async function uploadVideo(req, res, user) {
  const p = new URL(req.url, 'http://x').searchParams;
  if ((req.headers['x-requested-with'] || '') !== 'bidyo') throw new HttpError(403, 'Bad request');
  const title = (p.get('title') || '').trim();
  const description = (p.get('description') || '').trim();
  const category = p.get('category') || '';
  const visibility = p.get('visibility') || 'public';
  const status = p.get('status') || 'published';
  const filename = (p.get('filename') || '').toLowerCase();
  const duration = Math.min(Math.max(parseFloat(p.get('duration') || '0') || 0, 0), 86400);

  if (title.length < 1 || title.length > 100) throw new HttpError(400, 'Title is required (max 100 characters).');
  if (description.length > 2000) throw new HttpError(400, 'Description is too long (max 2000 characters).');
  if (!cfg.CATEGORIES.includes(category)) throw new HttpError(400, 'Pick a category.');
  if (!VISIBILITIES.includes(visibility)) throw new HttpError(400, 'Invalid visibility.');
  if (!STATUSES.includes(status)) throw new HttpError(400, 'Invalid status.');
  if (p.get('rights') !== '1') throw new HttpError(400, 'Please confirm the video is yours or you have permission to upload it.');
  const ext = path.extname(filename);
  const mime = cfg.FORMATS[ext];
  if (!mime) throw new HttpError(415, `Unsupported format. Use ${Object.keys(cfg.FORMATS).join(', ')}.`);
  const len = Number(req.headers['content-length']);
  if (!Number.isFinite(len) || len <= 0) throw new HttpError(411, 'Missing file size.');
  if (len > cfg.MAX_UPLOAD_BYTES) throw new HttpError(413, `File is too big (max ${Math.round(cfg.MAX_UPLOAD_BYTES / 1048576)} MB).`);
  if (v.countMine.get(user.id).n >= cfg.MAX_VIDEOS_PER_USER) throw new HttpError(403, 'You reached the video limit for your account.');
  rateLimit(`upload:${user.id}`, 30, 3600 * 1000);

  const busy = activeUploads.get(user.id) || 0;
  if (busy >= cfg.MAX_CONCURRENT_UPLOADS_PER_USER) throw new HttpError(429, 'Too many uploads at once. Wait for one to finish.');
  activeUploads.set(user.id, busy + 1);

  const id = crypto.randomBytes(8).toString('hex');
  const file = id + ext;
  const dest = path.join(cfg.UPLOAD_DIR, file);
  let size = 0, first = true;
  const guard = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > cfg.MAX_UPLOAD_BYTES) return cb(new HttpError(413, 'File is too big.'));
      if (first) { first = false; if (!sniffVideo(chunk)) return cb(new HttpError(415, 'That file does not look like a valid video.')); }
      cb(null, chunk);
    },
  });
  try {
    await pipeline(req, guard, fs.createWriteStream(dest, { flags: 'wx', mode: 0o640 }));
    if (size === 0) throw new HttpError(400, 'Empty file.');
    v.insert.run({ id, user_id: user.id, title, description, category, visibility, status, file, mime, size, duration, created_at: now() });
  } catch (err) {
    fs.promises.unlink(dest).catch(() => {});
    if (err instanceof HttpError) throw err;
    if (err && (err.code === 'ECONNRESET' || err.code === 'ERR_STREAM_PREMATURE_CLOSE' || err.message === 'aborted')) throw new HttpError(499, 'Upload cancelled.');
    console.error('[upload]', err);
    throw new HttpError(500, 'Upload failed. Please try again.');
  } finally {
    const left = (activeUploads.get(user.id) || 1) - 1;
    if (left <= 0) activeUploads.delete(user.id); else activeUploads.set(user.id, left);
  }
  send(res, 201, { ok: true, video: videoJson(v.get.get(id), user) });
}

async function putThumb(req, res, id, user) {
  if ((req.headers['x-requested-with'] || '') !== 'bidyo') throw new HttpError(403, 'Bad request');
  const r = v.get.get(id);
  if (!r || r.user_id !== user.id) throw new HttpError(404, 'Video not found');
  if (!(req.headers['content-type'] || '').startsWith('image/jpeg')) throw new HttpError(415, 'JPEG only.');
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > cfg.MAX_THUMB_BYTES) throw new HttpError(413, 'Thumbnail too large.'); chunks.push(c); }
  const buf = Buffer.concat(chunks);
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new HttpError(415, 'Not a JPEG.');
  await fs.promises.writeFile(path.join(cfg.UPLOAD_DIR, `${id}.jpg`), buf);
  v.setThumb.run(id);
  send(res, 200, { ok: true });
}

function streamFile(req, res, filePath, mime, cacheControl) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { throw new HttpError(404, 'File missing'); }
  const total = stat.size;
  const headers = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': cacheControl, 'X-Content-Type-Options': 'nosniff' };
  const range = req.headers.range;
  let start = 0, end = total - 1, status = 200;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m || (m[1] === '' && m[2] === '')) { res.writeHead(416, { 'Content-Range': `bytes */${total}` }); return res.end(); }
    if (m[1] === '') { start = Math.max(total - Number(m[2]), 0); }
    else { start = Number(m[1]); if (m[2] !== '') end = Math.min(Number(m[2]), total - 1); }
    if (start > end || start >= total) { res.writeHead(416, { 'Content-Range': `bytes */${total}` }); return res.end(); }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  const rs = fs.createReadStream(filePath, { start, end });
  rs.on('error', () => res.destroy());
  res.on('close', () => rs.destroy());
  rs.pipe(res);
}

function removeVideoFiles(r) {
  fs.promises.unlink(path.join(cfg.UPLOAD_DIR, r.file)).catch(() => {});
  fs.promises.unlink(path.join(cfg.UPLOAD_DIR, `${r.id}.jpg`)).catch(() => {});
}

/* ------------------------------------------------------------------ static */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = path.normalize(path.join(cfg.PUBLIC_DIR, rel));
  if (!full.startsWith(cfg.PUBLIC_DIR + path.sep)) throw new HttpError(404, 'Not found');
  let st;
  try { st = fs.statSync(full); } catch { st = null; }
  let file = full;
  if (!st || !st.isFile()) { if (path.extname(rel)) throw new HttpError(404, 'Not found'); file = path.join(cfg.PUBLIC_DIR, 'index.html'); st = fs.statSync(file); }
  const ext = path.extname(file);
  const html = ext === '.html';
  const etag = `W/"${st.size}-${Math.floor(st.mtimeMs)}"`;
  if (req.headers['if-none-match'] === etag) { res.writeHead(304); return res.end(); }
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': st.size,
    ETag: etag,
    'Cache-Control': html ? 'no-cache' : 'public, max-age=3600',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

/* ------------------------------------------------------------------ router */

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

const viewSeen = new Map(); // ip:video -> expiry (dedupe view counts)

async function handle(req, res) {
  for (const [k, val] of Object.entries(SEC_HEADERS)) res.setHeader(k, val);
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const method = req.method;

  if (!p.startsWith('/api/') && p !== '/healthz') {
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    return serveStatic(req, res, p);
  }
  if (p === '/healthz') return send(res, 200, { ok: true });

  // Cheap CSRF defence for every state-changing JSON call: cookie is SameSite=Lax AND a custom header is required.
  if (method !== 'GET' && method !== 'HEAD' && (req.headers['x-requested-with'] || '') !== 'bidyo') throw new HttpError(403, 'Bad request');

  const ip = clientIp(req);
  if (method === 'GET' && p === '/api/config') {
    return send(res, 200, {
      name: cfg.APP_NAME, categories: cfg.CATEGORIES, formats: Object.keys(cfg.FORMATS),
      maxUploadMb: Math.round(cfg.MAX_UPLOAD_BYTES / 1048576), otpDigits: 6,
      otpTtl: Math.round(cfg.OTP_TTL_MS / 1000), otpResend: Math.round(cfg.OTP_RESEND_MS / 1000),
    }, { 'Cache-Control': 'public, max-age=60' });
  }
  if (method === 'GET' && p === '/api/me') {
    const u = currentUser(req);
    return send(res, 200, { user: u ? publicUser(u) : null });
  }
  if (method === 'POST' && p === '/api/auth/request-otp') return requestOtp(req, res);
  if (method === 'POST' && p === '/api/auth/verify-otp') return verifyOtp(req, res);
  if (method === 'POST' && p === '/api/auth/logout') {
    const tok = parseCookies(req)[SESSION_COOKIE];
    if (tok) q.delSession.run(sha256(tok));
    setSessionCookie(res, '', 0);
    return send(res, 200, { ok: true });
  }

  if (method === 'GET' && p === '/api/videos') return listVideos(url, currentUser(req), res);
  if (method === 'POST' && p === '/api/videos') return uploadVideo(req, res, requireUser(req));
  if (method === 'GET' && p === '/api/my/videos') {
    const u = requireUser(req);
    return send(res, 200, { videos: v.mine.all(u.id).map(r => videoJson(r, u)) });
  }

  let m;
  if ((m = /^\/api\/videos\/([a-f0-9]{16})$/.exec(p))) {
    const id = m[1];
    if (method === 'GET') {
      const viewer = currentUser(req);
      const r = getVideoFor(id, viewer);
      return send(res, 200, { video: videoJson(r, viewer) });
    }
    if (method === 'PATCH') {
      const u = requireUser(req);
      const r = v.get.get(id);
      if (!r || r.user_id !== u.id) throw new HttpError(404, 'Video not found');
      const b = await readJson(req);
      const next = { title: r.title, description: r.description, category: r.category, visibility: r.visibility, status: r.status };
      if (b.title !== undefined) { next.title = String(b.title).trim(); if (!next.title || next.title.length > 100) throw new HttpError(400, 'Title is required (max 100 characters).'); }
      if (b.description !== undefined) { next.description = String(b.description).trim(); if (next.description.length > 2000) throw new HttpError(400, 'Description too long.'); }
      if (b.category !== undefined) { if (!cfg.CATEGORIES.includes(b.category)) throw new HttpError(400, 'Unknown category'); next.category = b.category; }
      if (b.visibility !== undefined) { if (!VISIBILITIES.includes(b.visibility)) throw new HttpError(400, 'Invalid visibility'); next.visibility = b.visibility; }
      if (b.status !== undefined) { if (!STATUSES.includes(b.status)) throw new HttpError(400, 'Invalid status'); next.status = b.status; }
      db.prepare('UPDATE videos SET title=@title, description=@description, category=@category, visibility=@visibility, status=@status WHERE id=@id').run({ ...next, id });
      return send(res, 200, { ok: true, video: videoJson(v.get.get(id), u) });
    }
    if (method === 'DELETE') {
      const u = requireUser(req);
      const r = v.get.get(id);
      if (!r || r.user_id !== u.id) throw new HttpError(404, 'Video not found');
      v.del.run(id); removeVideoFiles(r);
      return send(res, 200, { ok: true });
    }
  }
  if ((m = /^\/api\/videos\/([a-f0-9]{16})\/stream$/.exec(p)) && (method === 'GET' || method === 'HEAD')) {
    const r = getVideoFor(m[1], currentUser(req));
    return streamFile(req, res, path.join(cfg.UPLOAD_DIR, r.file), r.mime, r.visibility === 'public' && r.status === 'published' ? 'public, max-age=3600' : 'private, max-age=0');
  }
  if ((m = /^\/api\/videos\/([a-f0-9]{16})\/thumb$/.exec(p))) {
    if (method === 'GET' || method === 'HEAD') {
      const r = getVideoFor(m[1], currentUser(req));
      if (!r.has_thumb) throw new HttpError(404, 'No thumbnail');
      return streamFile(req, res, path.join(cfg.UPLOAD_DIR, `${r.id}.jpg`), 'image/jpeg', r.visibility === 'public' && r.status === 'published' ? 'public, max-age=86400' : 'private, max-age=0');
    }
    if (method === 'PUT') return putThumb(req, res, m[1], requireUser(req));
  }
  if ((m = /^\/api\/videos\/([a-f0-9]{16})\/view$/.exec(p)) && method === 'POST') {
    const r = getVideoFor(m[1], currentUser(req));
    const key = `${ip}:${r.id}`;
    const t = now();
    if (!(viewSeen.get(key) > t)) { viewSeen.set(key, t + 30 * 60 * 1000); v.view.run(r.id); }
    return send(res, 200, { ok: true });
  }

  throw new HttpError(404, 'Not found');
}

/* ------------------------------------------------------------------ server */

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    if (res.headersSent) { res.destroy(); return; }
    if (err instanceof HttpError) {
      const headers = err.extra && err.extra.retryAfter ? { 'Retry-After': String(err.extra.retryAfter) } : {};
      // If the request body wasn't consumed (e.g. rejected upload), close the connection so the client stops sending.
      if (req.method === 'POST' || req.method === 'PUT') headers.Connection = 'close';
      return send(res, err.status, { error: err.message, ...(err.extra || {}) }, headers);
    }
    console.error('[error]', req.method, req.url, err);
    send(res, 500, { error: 'Something went wrong.' });
  });
});
server.requestTimeout = 0;           // large uploads can take a while
server.headersTimeout = 30000;
server.keepAliveTimeout = 65000;
server.maxHeadersCount = 50;

// Housekeeping: expired sessions / OTPs / rate-limit buckets / view dedupe.
setInterval(() => {
  const t = now();
  q.purgeSessions.run(t);
  q.purgeOtps.run(t, t - 3600 * 1000);
  for (const [k, b] of buckets) if (b.reset <= t) buckets.delete(k);
  for (const [k, e] of viewSeen) if (e <= t) viewSeen.delete(k);
}, 10 * 60 * 1000).unref();

function shutdown() { console.log('\nShutting down...'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (require.main === module) {
  server.listen(cfg.PORT, cfg.HOST, () => {
    console.log(`${cfg.APP_NAME} running on http://${cfg.HOST === '0.0.0.0' ? 'localhost' : cfg.HOST}:${cfg.PORT}`);
    if (!cfg.SMTP_USER) console.log('SMTP not configured: OTP codes will be printed here in the console (set SMTP_USER / SMTP_PASS in .env to email them).');
  });
}
module.exports = { server };
