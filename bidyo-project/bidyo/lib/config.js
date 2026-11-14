'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

// Tiny .env loader (no dependencies). Real environment variables win.
(function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
})();

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const num = (k, d) => { const n = Number(env(k, d)); return Number.isFinite(n) ? n : d; };

const DATA_DIR = path.resolve(ROOT, env('DATA_DIR', 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Secret used to HMAC OTP codes. Persisted so restarts don't invalidate pending codes.
function loadSecret() {
  if (process.env.APP_SECRET) return process.env.APP_SECRET;
  const f = path.join(DATA_DIR, '.secret');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}

const production = env('NODE_ENV', 'development') === 'production';

module.exports = {
  ROOT,
  PUBLIC_DIR: path.join(ROOT, 'public'),
  DATA_DIR,
  UPLOAD_DIR,
  production,
  PORT: num('PORT', 3000),
  HOST: env('HOST', '0.0.0.0'),
  APP_SECRET: loadSecret(),
  TRUST_PROXY: env('TRUST_PROXY', '0') === '1',
  COOKIE_SECURE: env('COOKIE_SECURE', production ? '1' : '0') === '1',
  // Only Gmail accounts can sign in (per product spec).
  ALLOWED_EMAIL_DOMAINS: env('ALLOWED_EMAIL_DOMAINS', 'gmail.com,googlemail.com').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),

  OTP_TTL_MS: num('OTP_TTL_SECONDS', 300) * 1000,        // code valid for 5 minutes
  OTP_RESEND_MS: num('OTP_RESEND_SECONDS', 30) * 1000,   // resend cooldown
  OTP_MAX_ATTEMPTS: num('OTP_MAX_ATTEMPTS', 5),          // wrong tries per code
  OTP_MAX_PER_HOUR: num('OTP_MAX_PER_HOUR', 5),          // codes per email per hour
  SESSION_TTL_MS: num('SESSION_DAYS', 30) * 86400 * 1000,

  MAX_UPLOAD_BYTES: num('MAX_UPLOAD_MB', 500) * 1024 * 1024,
  MAX_THUMB_BYTES: 400 * 1024,
  MAX_CONCURRENT_UPLOADS_PER_USER: num('MAX_CONCURRENT_UPLOADS_PER_USER', 2),
  MAX_VIDEOS_PER_USER: num('MAX_VIDEOS_PER_USER', 200),

  // SMTP (use a Gmail address + App Password). If SMTP_USER is empty, codes are printed to the console (dev mode).
  SMTP_HOST: env('SMTP_HOST', 'smtp.gmail.com'),
  SMTP_PORT: num('SMTP_PORT', 465),
  SMTP_SECURE: env('SMTP_SECURE', 'ssl'),  // ssl (465) | starttls (587) | none (testing only)
  SMTP_USER: env('SMTP_USER', ''),
  SMTP_PASS: env('SMTP_PASS', ''),
  MAIL_FROM: env('MAIL_FROM', ''),
  DEV_RETURN_OTP: env('DEV_RETURN_OTP', '0') === '1' && !production,

  APP_NAME: env('APP_NAME', 'Bidyo'),
  CATEGORIES: ['Dance', 'Comedy', 'Food', 'Games'],
  FORMATS: { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4' },
};
