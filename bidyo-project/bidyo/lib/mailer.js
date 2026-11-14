'use strict';
// Minimal dependency-free SMTP client (implicit TLS on 465, STARTTLS on 587, or plain for local testing).
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const cfg = require('./config');

class Conn {
  constructor(sock) { this.pending = []; this.waiters = []; this.buf = ''; this.err = null; this.attach(sock); }
  attach(sock) {
    this.sock = sock;
    sock.setTimeout(20000, () => sock.destroy(new Error('SMTP timeout')));
    this._d = d => { this.buf += d.toString('utf8'); this.drain(); };
    this._e = e => this.fail(e);
    this._c = () => this.fail(new Error('SMTP connection closed'));
    sock.on('data', this._d); sock.on('error', this._e); sock.on('close', this._c);
  }
  detach() { this.sock.off('data', this._d); this.sock.off('error', this._e); this.sock.off('close', this._c); this.sock.setTimeout(0); }
  fail(e) { this.err = e; while (this.waiters.length) this.waiters.shift().reject(e); }
  drain() {
    for (;;) {
      const lines = this.buf.split('\r\n');
      let end = -1;
      for (let i = 0; i < lines.length - 1; i++) if (/^\d{3}( |$)/.test(lines[i])) { end = i; break; }
      if (end < 0) return;
      const resp = { code: Number(lines[end].slice(0, 3)), text: lines.slice(0, end + 1).join('\n') };
      this.buf = lines.slice(end + 1).join('\r\n');
      const w = this.waiters.shift();
      if (w) w.resolve(resp); else this.pending.push(resp);
    }
  }
  read() {
    if (this.pending.length) return Promise.resolve(this.pending.shift());
    if (this.err) return Promise.reject(this.err);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
  async cmd(line, ok) {
    this.sock.write(line + '\r\n');
    return this.expect(ok, line.startsWith('AUTH') || /^[A-Za-z0-9+/=]{12,}$/.test(line) ? '(auth)' : line);
  }
  async expect(ok, what) {
    const r = await this.read();
    if (!ok.includes(r.code)) throw new Error(`SMTP ${what || ''} failed: ${r.code} ${r.text}`);
    return r;
  }
}

function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }
function wrap76(s) { return s.replace(/(.{76})/g, '$1\r\n'); }

function buildMessage({ from, to, subject, text, html }) {
  const boundary = 'b_' + crypto.randomBytes(12).toString('hex');
  const domain = (from.match(/@([^>\s]+)/) || [, 'localhost'])[1];
  const head = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${b64(subject)}?=`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomBytes(12).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].join('\r\n');
  const part = (type, body) => `--${boundary}\r\nContent-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(b64(body))}\r\n`;
  return `${head}\r\n\r\n${part('text/plain', text)}${part('text/html', html)}--${boundary}--\r\n`;
}

async function smtpSend({ to, subject, text, html }) {
  const mode = cfg.SMTP_SECURE;
  const fromAddr = cfg.SMTP_USER;
  const from = cfg.MAIL_FROM || `${cfg.APP_NAME} <${fromAddr}>`;
  const fromEnvelope = (from.match(/<([^>]+)>/) || [, from])[1];

  const sock = mode === 'ssl'
    ? tls.connect({ host: cfg.SMTP_HOST, port: cfg.SMTP_PORT, servername: cfg.SMTP_HOST })
    : net.connect({ host: cfg.SMTP_HOST, port: cfg.SMTP_PORT });
  let c = new Conn(sock);
  try {
    await c.expect([220], 'greeting');
    await c.cmd('EHLO bidyo.local', [250]);
    if (mode === 'starttls') {
      await c.cmd('STARTTLS', [220]);
      c.detach();
      const secured = tls.connect({ socket: c.sock, servername: cfg.SMTP_HOST });
      await new Promise((res, rej) => { secured.once('secureConnect', res); secured.once('error', rej); });
      c = new Conn(secured);
      await c.cmd('EHLO bidyo.local', [250]);
    }
    if (cfg.SMTP_PASS) {
      await c.cmd('AUTH LOGIN', [334]);
      await c.cmd(b64(cfg.SMTP_USER), [334]);
      await c.cmd(b64(cfg.SMTP_PASS), [235]);
    }
    await c.cmd(`MAIL FROM:<${fromEnvelope}>`, [250]);
    await c.cmd(`RCPT TO:<${to}>`, [250, 251]);
    await c.cmd('DATA', [354]);
    c.sock.write(buildMessage({ from, to, subject, text, html }).replace(/^\./gm, '..') + '\r\n.\r\n');
    await c.expect([250], 'DATA');
    try { c.sock.write('QUIT\r\n'); } catch {}
  } finally {
    c.sock.destroy();
  }
}

function otpEmail(code) {
  const mins = Math.round(cfg.OTP_TTL_MS / 60000);
  const text = `Your ${cfg.APP_NAME} code is ${code}\n\nIt expires in ${mins} minutes. Only you should know this code - ${cfg.APP_NAME} will never ask for it in chat or over a call.\n\nIf you didn't ask for it, you can ignore this email.`;
  const html = `<!doctype html><html><body style="margin:0;background:#FFF8EA;font-family:Nunito,Arial,sans-serif;color:#1B1340">
<div style="max-width:440px;margin:0 auto;padding:32px 20px">
  <div style="font-size:30px;font-weight:800;margin-bottom:16px">bidy<span style="color:#FF5A5F">o</span></div>
  <div style="background:#fff;border:3px solid #1B1340;border-radius:24px;padding:28px;box-shadow:6px 6px 0 #1B1340;text-align:center">
    <h1 style="margin:0 0 8px;font-size:24px">Check your Gmail!</h1>
    <p style="margin:0 0 18px;color:#4b4277">Here is your 6-digit code:</p>
    <div style="font-size:38px;letter-spacing:10px;font-weight:800;background:#FFF8EA;border:3px solid #1B1340;border-radius:16px;padding:14px 8px;display:inline-block">${code}</div>
    <p style="margin:18px 0 0;color:#4b4277;font-size:14px">Expires in ${mins} minutes.</p>
  </div>
  <p style="font-size:13px;color:#4b4277;margin-top:18px">Only you should know this code. ${cfg.APP_NAME} will never ask for it in chat or over a call. Didn't request it? Ignore this email.</p>
</div></body></html>`;
  return { subject: `${code} is your ${cfg.APP_NAME} code`, text, html };
}

async function sendOtp(to, code) {
  if (!cfg.SMTP_USER) {
    console.log(`[mail:dev] SMTP not configured. OTP for ${to}: ${code}`);
    return { delivered: false };
  }
  await smtpSend({ to, ...otpEmail(code) });
  return { delivered: true };
}

module.exports = { sendOtp, smtpSend };
