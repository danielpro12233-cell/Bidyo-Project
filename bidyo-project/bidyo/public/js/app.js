'use strict';
/* Bidyo front-end: tiny hash-routed SPA, no build step, no dependencies.
   All user text is inserted with textContent (via h()), never innerHTML, so it is XSS-safe. */

/* ============================ helpers ============================ */
const app = document.getElementById('app');
const state = { me: null, config: { categories: ['Dance', 'Comedy', 'Food', 'Games'], formats: ['.mp4', '.webm', '.mov'], maxUploadMb: 500, otpTtl: 300, otpResend: 30 }, next: null, pendingEmail: null };
let cleanup = [];                       // functions to run when leaving a page
const onLeave = fn => cleanup.push(fn);

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;        // only ever used with static icon strings below
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

const ICON = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.6c0-1.1 1.2-1.8 2.1-1.2l10.2 6.6c.9.6.9 1.8 0 2.4L9.1 19.0C8.2 19.6 7 18.9 7 17.8z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="4" width="4.5" height="16" rx="1.5"/><rect x="13.5" y="4" width="4.5" height="16" rx="1.5"/></svg>',
  vol: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 4V5L7 9z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  mute: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 4V5L7 9z"/><path d="M16 9l5 6M21 9l-5 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  full: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5v2H6v3zm11-5h5v5h-2V6h-3zM4 15h2v3h3v2H4zm14 0h2v5h-5v-2h3z"/></svg>',
  shield: '<svg viewBox="0 0 32 32" fill="none" stroke="#1B1340" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 3l11 4v8c0 7-4.6 11.6-11 14C9.6 26.6 5 22 5 15V7z"/><path d="M11 16l3.8 3.8L21.5 12"/></svg>',
  mail: '<svg viewBox="0 0 48 48" fill="none" stroke="#1B1340" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10" width="38" height="28" rx="7"/><path d="M8 15l16 12 16-12"/></svg>',
  timer: '<svg viewBox="0 0 24 24" fill="none" stroke="#1B1340" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="13.5" r="7.5"/><path d="M12 9.5v4l2.5 1.5M9.5 2.5h5"/></svg>',
  upload: '<svg viewBox="0 0 48 48" fill="none" stroke="#1B1340" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M24 34V10M14 19l10-10 10 10M12 41h24"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#1B1340" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5"/></svg>',
};
const icon = (name, cls) => h('span', { class: cls || 'ico-wrap', html: ICON[name], style: 'display:contents' });

function toast(msg, isErr) {
  const t = h('div', { class: 'toast' + (isErr ? ' err' : '') }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), 4200);
}

async function api(path, { method = 'GET', body, raw } = {}) {
  const headers = { 'X-Requested-With': 'bidyo' };
  let payload = raw;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  let res;
  try { res = await fetch('/api' + path, { method, headers, body: payload, credentials: 'same-origin' }); }
  catch { throw Object.assign(new Error('No connection. Check your internet and try again.'), { status: 0 }); }
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw Object.assign(new Error((data && data.error) || 'Something went wrong.'), { status: res.status, data });
  return data;
}

const fmtTime = s => { s = Math.max(0, Math.floor(s || 0)); const m = Math.floor(s / 60), r = s % 60; return `${m}:${String(r).padStart(2, '0')}`; };
const mmss = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
const fmtViews = n => n === 1 ? '1 view' : `${n.toLocaleString()} views`;
const fmtSize = b => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.ceil(b / 1024) + ' KB';
const colorOf = id => parseInt(id.slice(0, 4), 16) % 4;

/* ============================ shared pieces ============================ */
function brand() {
  return h('a', { class: 'brand', href: '#/', 'aria-label': 'Bidyo home' }, h('img', { src: '/img/logo.svg', alt: '' }), h('span', {}, 'bidy', h('b', {}, 'o')));
}

function userMenu(light) {
  const wrap = h('div', { class: 'menu' });
  const pop = h('div', { class: 'menu-pop', hidden: true },
    h('p', {}, state.me.email),
    h('div', { class: 'row' },
      h('a', { class: 'btn sm sunny', href: '#/upload' }, 'Upload a video'),
      h('button', { class: 'btn sm ghost', onclick: logout }, 'Log out')));
  const btn = h('button', { class: 'avatar', 'aria-label': 'Account menu', 'aria-expanded': 'false', onclick: e => { e.stopPropagation(); pop.hidden = !pop.hidden; btn.setAttribute('aria-expanded', String(!pop.hidden)); } }, state.me.initial);
  const close = () => { pop.hidden = true; };
  document.addEventListener('click', close); onLeave(() => document.removeEventListener('click', close));
  pop.addEventListener('click', e => e.stopPropagation());
  wrap.append(btn, pop);
  return wrap;
}

function topbar({ light = false, search = true, nav = true, back = false } = {}) {
  const cur = location.hash;
  const bar = h('header', { class: 'topbar' + (light ? ' light' : '') }, brand());
  if (nav) bar.append(h('nav', { class: 'nav', 'aria-label': 'Categories' },
    h('a', { href: '#/', 'aria-current': cur === '#/' || cur === '' ? 'page' : null }, 'Home'),
    state.config.categories.map(c => h('a', { href: `#/c/${c}`, 'aria-current': cur === `#/c/${c}` ? 'page' : null }, c))));
  if (search) {
    const input = h('input', { type: 'search', placeholder: 'Search videos', 'aria-label': 'Search videos', maxlength: '80', value: cur.startsWith('#/search/') ? decodeURIComponent(cur.slice(9)) : '' });
    bar.append(h('div', { class: 'spacer' }), h('form', { class: 'search', role: 'search', onsubmit: e => { e.preventDefault(); const q = input.value.trim(); location.hash = q ? `#/search/${encodeURIComponent(q)}` : '#/'; } }, input));
  } else bar.append(h('div', { class: 'spacer' }));
  if (back) bar.append(h('a', { class: 'nav-back', href: '#/', style: 'font-weight:800;text-decoration:none;white-space:nowrap' }, '← Back to browsing'));
  if (state.me) {
    if (light) bar.append(h('div', { class: 'badges' }, h('span', { class: 'badge' }, icon('check'), 'Gmail verified')));
    else bar.append(h('a', { class: 'btn sm sunny long', href: '#/upload' }, 'Upload'));
    bar.append(userMenu(light));
  } else {
    bar.append(h('a', { class: 'btn sunny sm', href: '#/login' }, 'Sign in to upload'));
  }
  return bar;
}

function thumb(v, { big } = {}) {
  const t = h('div', { class: `thumb c${colorOf(v.id)}${v.hasThumb ? ' has-shot' : ''}` });
  if (v.hasThumb) t.append(h('img', { class: 'shot', src: `/api/videos/${v.id}/thumb`, alt: '', loading: 'lazy' }));
  const pw = h('span', { html: ICON.play, style: 'display:contents' });
  pw.firstChild.classList.add('play');
  t.append(pw);
  if (v.duration > 0 && !big) t.append(h('span', { class: 'dur' }, fmtTime(v.duration)));
  return t;
}
function tile(v) {
  return h('a', { class: 'tile', href: `#/watch/${v.id}`, title: v.title }, thumb(v), h('span', { class: 't' }, v.title), h('span', { class: 'm' }, `${v.creator.name} · ${fmtViews(v.views)}`));
}
const skeletonRow = () => h('div', { class: 'row-scroll' }, [1, 2, 3, 4].map(() => h('div', { class: 'skeleton' })));
function ctaBox(title, text) {
  return h('section', { class: 'cta' },
    h('div', {}, h('h3', {}, title), h('p', {}, text)),
    h('a', { class: 'btn coral', style: '--sh:var(--sunny)', href: state.me ? '#/upload' : '#/login' }, state.me ? 'Upload a video' : 'Sign in to upload'));
}
function setPage(theme, ...nodes) {
  document.body.className = theme;
  app.replaceChildren(...nodes);
  window.scrollTo(0, 0);
}
function setTitle(t) { document.title = t ? `${t} · Bidyo` : 'Bidyo — Upload. Share. Have fun!'; }

/* ============================ pages ============================ */
async function pageHome(params) {
  setTitle('');
  const rows = h('div', {});
  const hero = h('div', {});
  setPage('dark', topbar(), h('main', { class: 'page' }, hero, rows));
  rows.append(h('h2', { class: 'section-title' }, 'Trending now'), skeletonRow());
  let videos;
  try { videos = (await api('/videos?limit=200&sort=new')).videos; }
  catch (e) { rows.replaceChildren(h('div', { class: 'empty' }, h('h3', {}, "Can't load videos"), h('p', {}, e.message))); return; }

  const trending = [...videos].sort((a, b) => b.views - a.views || b.createdAt - a.createdAt);
  rows.replaceChildren();
  if (!videos.length) {
    hero.replaceChildren(h('section', { class: 'hero' },
      h('div', {}, h('span', { class: 'pill' }, 'Welcome'), h('h1', {}, 'Upload. Share. Have fun!'),
        h('p', {}, 'Everything here is free to watch, no account needed. Be the first to share a video!'),
        h('a', { class: 'btn', href: state.me ? '#/upload' : '#/login' }, state.me ? 'Upload a video' : 'Sign in to upload'))));
    rows.append(h('div', { class: 'empty', style: 'margin-top:40px' }, h('h3', {}, 'No videos yet'), h('p', {}, 'Published videos will show up here.')));
    return;
  }
  const f = trending[0];
  hero.replaceChildren(h('section', { class: 'hero' },
    h('div', {}, h('span', { class: 'pill' }, 'Featured today'), h('h1', {}, f.title),
      h('p', {}, 'Press play and enjoy. Everything here is free to watch, no account needed.'),
      h('a', { class: 'btn', href: `#/watch/${f.id}` }, h('span', { html: ICON.play, style: 'display:inline-flex;width:18px;fill:#1B1340' }), 'Watch now')),
    h('a', { class: 'art', href: `#/watch/${f.id}`, 'aria-label': `Watch ${f.title}` }, thumb(f, { big: true }))));
  const section = (title, list, link) => list.length && rows.append(
    h('h2', { class: 'section-title' }, link ? h('a', { href: link, style: 'text-decoration:none' }, title) : title),
    h('div', { class: 'row-scroll' }, list.map(tile)));
  section('Trending now', trending.slice(0, 12));
  for (const c of state.config.categories) section(c, videos.filter(v => v.category === c).slice(0, 12), `#/c/${c}`);
  rows.append(ctaBox('Got a video of your own?', 'Watching never needs an account. Sign in only when you want to upload.'));
}

async function pageList(title, query) {
  setTitle(title);
  const box = h('div', {});
  setPage('dark', topbar(), h('main', { class: 'page' }, h('h2', { class: 'section-title', style: 'margin-top:8px' }, title), box));
  box.append(h('div', { class: 'row-scroll' }, [1, 2, 3, 4].map(() => h('div', { class: 'skeleton' }))));
  try {
    const { videos } = await api('/videos?limit=200&sort=new' + query);
    box.replaceChildren(videos.length ? h('div', { class: 'grid' }, videos.map(tile)) : h('div', { class: 'empty' }, h('h3', {}, 'Nothing here yet'), h('p', {}, 'Try a different search, or be the first to upload one!')));
  } catch (e) { box.replaceChildren(h('div', { class: 'empty' }, h('h3', {}, 'Oops'), h('p', {}, e.message))); }
}

async function pageWatch(id) {
  setPage('dark', topbar({ search: false, nav: false, back: true }), h('main', { class: 'page' }, h('div', { class: 'skeleton', style: 'max-width:900px;flex:none' })));
  let v;
  try { v = (await api('/videos/' + id)).video; }
  catch (e) { setPage('dark', topbar(), h('main', { class: 'page' }, h('div', { class: 'empty' }, h('h3', {}, 'Video not found'), h('p', {}, 'It may have been removed or made private.'), h('a', { class: 'btn', href: '#/' }, 'Back to browsing')))); return; }
  setTitle(v.title);

  const video = h('video', { preload: 'metadata', playsinline: true, src: `/api/videos/${v.id}/stream`, poster: v.hasThumb ? `/api/videos/${v.id}/thumb` : null });
  const bigplay = h('button', { class: 'bigplay', 'aria-label': 'Play', html: ICON.play });
  const stage = h('div', { class: 'stage' }, video, bigplay);
  const playBtn = h('button', { class: 'ctl', 'aria-label': 'Play', html: ICON.play });
  const fill = h('i', {});
  const bar = h('div', { class: 'bar', role: 'slider', tabindex: '0', 'aria-label': 'Seek', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, fill);
  const time = h('span', { class: 'time' }, `0:00 / ${fmtTime(v.duration)}`);
  const muteBtn = h('button', { class: 'ctl', 'aria-label': 'Mute', html: ICON.vol });
  const fsBtn = h('button', { class: 'ctl', 'aria-label': 'Fullscreen', html: ICON.full });
  const player = h('div', { class: 'player' }, stage, h('div', { class: 'controls' }, playBtn, bar, time, muteBtn, fsBtn));

  const toggle = () => (video.paused ? video.play().catch(() => {}) : video.pause());
  let counted = false;
  stage.addEventListener('click', e => { if (e.target === stage || e.target === video || bigplay.contains(e.target)) toggle(); });
  playBtn.onclick = toggle;
  const dur = () => (isFinite(video.duration) && video.duration > 0 ? video.duration : v.duration);
  video.addEventListener('play', () => { player.classList.add('playing'); playBtn.innerHTML = ICON.pause; playBtn.setAttribute('aria-label', 'Pause'); if (!counted) { counted = true; api(`/videos/${v.id}/view`, { method: 'POST' }).catch(() => {}); } });
  video.addEventListener('pause', () => { player.classList.remove('playing'); playBtn.innerHTML = ICON.play; playBtn.setAttribute('aria-label', 'Play'); });
  video.addEventListener('ended', () => { player.classList.remove('playing'); });
  const upd = () => { const d = dur() || 1; const pct = Math.min(100, (video.currentTime / d) * 100); fill.style.width = pct + '%'; bar.setAttribute('aria-valuenow', String(Math.round(pct))); time.textContent = `${fmtTime(video.currentTime)} / ${fmtTime(dur())}`; };
  video.addEventListener('timeupdate', upd); video.addEventListener('loadedmetadata', upd);
  video.addEventListener('error', () => toast("This video can't be played in your browser.", true));
  const seek = e => { const r = bar.getBoundingClientRect(); const p = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); if (dur()) video.currentTime = p * dur(); };
  let dragging = false;
  bar.addEventListener('pointerdown', e => { dragging = true; bar.setPointerCapture(e.pointerId); seek(e); });
  bar.addEventListener('pointermove', e => dragging && seek(e));
  bar.addEventListener('pointerup', () => { dragging = false; });
  bar.addEventListener('keydown', e => { if (e.key === 'ArrowRight') video.currentTime += 5; if (e.key === 'ArrowLeft') video.currentTime -= 5; });
  muteBtn.onclick = () => { video.muted = !video.muted; muteBtn.innerHTML = video.muted ? ICON.mute : ICON.vol; };
  fsBtn.onclick = () => (document.fullscreenElement ? document.exitFullscreen() : player.requestFullscreen && player.requestFullscreen());
  const keys = e => { if (e.target.closest('input,textarea,select')) return; if (e.code === 'Space' && e.target === document.body) { e.preventDefault(); toggle(); } };
  document.addEventListener('keydown', keys); onLeave(() => { document.removeEventListener('keydown', keys); video.pause(); video.removeAttribute('src'); video.load(); });

  const side = h('aside', { class: 'side' }, h('h2', {}, 'Up next'), h('div', { id: 'upnext' }),
    h('section', { class: 'cta' }, h('h3', {}, state.me ? 'Share yours!' : 'Want to share yours?'),
      h('p', {}, state.me ? 'Jump to the upload page anytime.' : 'Sign in only if you want to upload. Watching stays free for everyone.'),
      h('a', { class: 'link', href: state.me ? '#/upload' : '#/login' }, state.me ? 'Upload a video →' : 'Sign in to upload →')));

  const main = h('div', {}, player,
    h('h1', {}, v.title),
    h('div', { class: 'byline' }, h('span', { class: 'avatar sm', style: 'background:var(--coral)' }, v.creator.initial), v.creator.name,
      h('span', { class: 'pill' }, v.category), h('span', { class: 'views' }, fmtViews(v.views))),
    v.description ? h('div', { class: 'desc' }, v.description) : null);

  setPage('dark', topbar({ search: false, nav: false, back: true }), h('main', { class: 'page' }, h('div', { class: 'watch' }, main, side)));
  try {
    const all = (await api('/videos?limit=40&sort=new')).videos.filter(x => x.id !== v.id);
    all.sort((a, b) => (b.category === v.category) - (a.category === v.category) || b.views - a.views);
    const box = side.querySelector('#upnext');
    all.slice(0, 6).forEach(x => box.append(h('a', { class: 'up', href: `#/watch/${x.id}` }, thumb(x), h('div', {}, h('b', {}, x.title), h('small', {}, x.creator.name)))));
    if (!all.length) box.append(h('p', { style: 'color:var(--muted-dark)' }, 'No other videos yet.'));
  } catch {}
}

/* ---------- login (step 1) ---------- */
function pageLogin() {
  setTitle('Log in to upload');
  if (state.me) { location.hash = '#/upload'; return; }
  const err = h('div', { class: 'err', role: 'alert' });
  const input = h('input', { type: 'email', inputmode: 'email', autocomplete: 'email', placeholder: 'yourname@gmail.com', 'aria-label': 'Your Gmail address', required: true, maxlength: '254', value: state.pendingEmail || '' });
  const btn = h('button', { class: 'btn grape block', type: 'submit' }, 'Send code to Gmail');
  const form = h('form', { novalidate: true, onsubmit: async e => {
    e.preventDefault(); err.textContent = '';
    const email = input.value.trim();
    if (!/^[^@\s]+@(gmail|googlemail)\.com$/i.test(email)) { err.textContent = 'Please enter a Gmail address (name@gmail.com).'; input.focus(); return; }
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const r = await api('/auth/request-otp', { method: 'POST', body: { email } });
      state.pendingEmail = email; state.otp = { masked: r.email, expiresAt: Date.now() + r.expiresIn * 1000, resendAt: Date.now() + r.resendIn * 1000, dev: r.devCode };
      location.hash = '#/verify';
    } catch (ex) {
      if (ex.status === 429 && state.pendingEmail === email && state.otp) { location.hash = '#/verify'; return; }
      err.textContent = ex.message; btn.disabled = false; btn.textContent = 'Send code to Gmail';
    }
  } },
    h('div', { class: 'gmail-row' }, h('span', { class: 'g', 'aria-hidden': 'true' }, 'G'), input), err, btn);

  const card = h('div', { class: 'card' },
    h('div', { class: 'steps' }, h('i', { class: 'on' }), h('i'), ), h('p', { class: 'step-label' }, 'Step 1 of 2 · Your Gmail'),
    h('h1', {}, 'Log in to upload'),
    h('p', {}, 'Watching is free and needs no account. Sign in only to upload. We need your Gmail to make sure it\'s really you.'),
    form,
    h('div', { class: 'note' }, h('span', { html: ICON.shield, style: 'display:contents' }), h('span', {}, 'We never see your password. We only send you a 6-digit code by Gmail.')),
    h('p', { class: 'foot' }, 'Just here to watch? ', h('a', { href: '#/' }, 'Keep browsing'), h('br'), 'By continuing, you agree to the ', h('a', { href: '#/terms' }, 'Terms'), ' and ', h('a', { href: '#/privacy' }, 'Privacy Policy'), '.'));

  const art = h('div', { class: 'cards-art', 'aria-hidden': 'true' }, ['a', 'b', 'c'].map(c => h('span', { class: c, html: ICON.play })));
  setPage('', h('div', { class: 'split' },
    h('section', { class: 'left' }, h('a', { class: 'brand', href: '#/' }, h('img', { src: '/img/logo.svg', alt: '' }), h('span', {}, 'bidy', h('b', {}, 'o'))),
      h('h1', {}, 'Show off your ', h('em', {}, 'best'), ' video!'),
      h('p', {}, 'An account is only needed to upload. Your account is safe, and only you have control of it.'), art),
    h('section', { class: 'right' }, card)));
  input.focus();
}

/* ---------- verify (step 2) ---------- */
function pageVerify() {
  setTitle('Verify your Gmail');
  if (state.me) { location.hash = '#/upload'; return; }
  if (!state.pendingEmail || !state.otp) { location.hash = '#/login'; return; }
  const N = 6;
  const err = h('div', { class: 'err', role: 'alert' });
  const boxes = Array.from({ length: N }, (_, i) => h('input', { type: 'text', inputmode: 'numeric', pattern: '[0-9]*', maxlength: '1', autocomplete: i === 0 ? 'one-time-code' : 'off', 'aria-label': `Digit ${i + 1}` }));
  const wrap = h('div', { class: 'otp' }, boxes);
  const code = () => boxes.map(b => b.value).join('');
  const btn = h('button', { class: 'btn grape block', type: 'button', onclick: submit }, 'Verify and finish');
  const expiresEl = h('span', {}, '');
  const resendBtn = h('button', { class: 'link', type: 'button', onclick: resend, disabled: true }, 'Resend code');
  const resendInfo = h('span', {}, '');

  function fillFrom(i, digits) { digits.split('').slice(0, N - i).forEach((d, k) => { boxes[i + k].value = d; }); const nxt = Math.min(N - 1, i + digits.length); boxes[nxt].focus(); if (code().length === N) submit(); }
  boxes.forEach((b, i) => {
    b.addEventListener('input', () => { const d = b.value.replace(/\D/g, ''); b.value = ''; if (d) fillFrom(i, d); });
    b.addEventListener('keydown', e => {
      if (e.key === 'Backspace' && !b.value && i > 0) { boxes[i - 1].value = ''; boxes[i - 1].focus(); }
      if (e.key === 'ArrowLeft' && i > 0) boxes[i - 1].focus();
      if (e.key === 'ArrowRight' && i < N - 1) boxes[i + 1].focus();
      if (e.key === 'Enter') submit();
    });
    b.addEventListener('paste', e => { e.preventDefault(); const d = (e.clipboardData.getData('text') || '').replace(/\D/g, ''); if (d) fillFrom(0, d); });
    b.addEventListener('focus', () => b.select());
  });

  let busy = false;
  async function submit() {
    if (busy) return; err.textContent = ''; wrap.classList.remove('bad');
    if (code().length < N) { err.textContent = 'Enter all 6 digits.'; return; }
    busy = true; btn.disabled = true; btn.textContent = 'Checking…';
    try {
      const r = await api('/auth/verify-otp', { method: 'POST', body: { email: state.pendingEmail, code: code() } });
      state.me = r.user; state.otp = null; state.pendingEmail = null;
      toast('Welcome to Bidyo! You\'re verified.');
      const dest = state.next || '#/upload'; state.next = null; location.hash = dest;
    } catch (ex) {
      err.textContent = ex.message; wrap.classList.add('bad');
      if (ex.data && (ex.data.code === 'expired' || ex.data.code === 'locked')) { state.otp.expiresAt = 0; }
      boxes.forEach(b => (b.value = '')); boxes[0].focus();
      btn.disabled = false; btn.textContent = 'Verify and finish';
    } finally { busy = false; }
  }
  async function resend() {
    resendBtn.disabled = true; err.textContent = '';
    try {
      const r = await api('/auth/request-otp', { method: 'POST', body: { email: state.pendingEmail } });
      state.otp = { masked: r.email, expiresAt: Date.now() + r.expiresIn * 1000, resendAt: Date.now() + r.resendIn * 1000, dev: r.devCode };
      boxes.forEach(b => (b.value = '')); boxes[0].focus(); toast('A new code is on its way.'); devHint();
    } catch (ex) { err.textContent = ex.message; if (ex.data && ex.data.retryAfter) state.otp.resendAt = Date.now() + ex.data.retryAfter * 1000; }
  }
  const dev = h('p', { class: 'foot', style: 'font-weight:800' });
  function devHint() { dev.textContent = state.otp && state.otp.dev ? `Dev mode — your code: ${state.otp.dev}` : ''; }
  devHint();

  const tick = () => {
    const left = Math.max(0, Math.round((state.otp.expiresAt - Date.now()) / 1000));
    expiresEl.textContent = left > 0 ? `Expires in ${mmss(left)}` : 'Code expired';
    const rl = Math.max(0, Math.round((state.otp.resendAt - Date.now()) / 1000));
    resendBtn.disabled = rl > 0; resendInfo.textContent = rl > 0 ? ` (available in ${mmss(rl)})` : '';
  };
  tick(); const iv = setInterval(tick, 1000); onLeave(() => clearInterval(iv));

  const card = h('div', { class: 'card center' },
    h('div', { class: 'steps' }, h('i', { class: 'on' }), h('i', { class: 'on' })), h('p', { class: 'step-label', style: 'text-align:left' }, 'Step 2 of 2 · Verify your Gmail'),
    h('div', { class: 'mail-ico', html: ICON.mail }),
    h('h2', {}, 'Check your Gmail!'),
    h('p', { style: 'margin-bottom:2px' }, 'We sent a 6-digit code to'), h('p', { style: 'color:var(--ink);font-weight:800;font-size:19px' }, state.otp.masked),
    wrap, h('div', {}, h('span', { class: 'timer' }, h('span', { html: ICON.timer, style: 'display:contents' }), expiresEl)), err, btn,
    h('p', { class: 'foot' }, 'Didn\'t get it? ', resendBtn, resendInfo),
    h('p', { class: 'foot', style: 'margin-top:6px' }, 'Wrong Gmail? ', h('button', { class: 'link', type: 'button', onclick: () => { location.hash = '#/login'; } }, 'Go back')),
    dev,
    h('div', { class: 'note', style: 'text-align:left' }, h('span', {}, 'Only you should know this code. Bidyo will never ask for it in chat or over a call. Each code has limited tries to protect your account.')));
  setPage('', h('div', { class: 'auth-solo' }, brand(), card));
  boxes[0].focus();
}

/* ---------- upload ---------- */
async function pageUpload() {
  setTitle('Upload a video');
  if (!state.me) { state.next = '#/upload'; location.hash = '#/login'; return; }
  const cfgc = state.config;
  let file = null, thumbBlob = null, duration = 0, previewUrl = null, xhr = null;
  onLeave(() => { if (previewUrl) URL.revokeObjectURL(previewUrl); if (xhr) xhr.abort(); });

  const fileInput = h('input', { type: 'file', accept: cfgc.formats.join(',') + ',video/*', class: 'sr', tabindex: '-1', 'aria-hidden': 'true' });
  const drop = h('div', { class: 'drop', role: 'group', 'aria-label': 'Video file drop area' });
  const renderDrop = () => {
    if (!file) {
      drop.replaceChildren(h('div', { class: 'ico', html: ICON.upload }), h('h2', {}, 'Drag your video here'),
        h('p', {}, `or choose from your device · up to ${cfgc.maxUploadMb >= 1024 ? (cfgc.maxUploadMb / 1024) + ' GB' : cfgc.maxUploadMb + ' MB'} · ${cfgc.formats.map(f => f.slice(1).toUpperCase()).join(', ')}`),
        h('button', { class: 'btn grape', type: 'button', onclick: () => fileInput.click() }, 'Choose file'));
    } else {
      const pv = h('video', { src: previewUrl, muted: true, preload: 'metadata', playsinline: true });
      drop.replaceChildren(h('div', { class: 'picked' }, pv, h('div', {}, h('b', {}, file.name), h('span', { style: 'color:var(--muted)' }, `${fmtSize(file.size)}${duration ? ' · ' + fmtTime(duration) : ''}`), h('br'),
        h('button', { class: 'link', type: 'button', onclick: () => fileInput.click() }, 'Choose a different file'))));
    }
  };
  async function setFile(f) {
    if (!f) return;
    const ext = '.' + f.name.split('.').pop().toLowerCase();
    if (!cfgc.formats.includes(ext)) return toast(`Unsupported format. Use ${cfgc.formats.join(', ')}`, true);
    if (f.size > cfgc.maxUploadMb * 1048576) return toast(`That file is bigger than ${cfgc.maxUploadMb} MB.`, true);
    if (f.size === 0) return toast('That file is empty.', true);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    file = f; previewUrl = URL.createObjectURL(f); thumbBlob = null; duration = 0; renderDrop();
    if (!titleIn.value) titleIn.value = f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 100);
    try { const m = await probe(previewUrl); duration = m.duration; thumbBlob = m.thumb; renderDrop(); } catch {}
  }
  fileInput.addEventListener('change', () => { setFile(fileInput.files[0]); fileInput.value = ''; });
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => setFile(e.dataTransfer.files[0]));

  const titleIn = h('input', { class: 'input', id: 'title', placeholder: 'e.g. Dancing in the rain!', maxlength: '100' });
  const descIn = h('textarea', { class: 'textarea', id: 'desc', placeholder: "What's happening in this video?", maxlength: '2000' });
  const visSel = h('select', { class: 'select', id: 'vis' }, h('option', { value: 'public' }, 'Everyone (Public)'), h('option', { value: 'unlisted' }, 'Anyone with the link'), h('option', { value: 'private' }, 'Only me'));
  const chips = cfgc.categories.map((c, i) => h('label', { class: 'chip' }, h('input', { type: 'radio', name: 'cat', value: c, checked: i === 0 }), h('span', {}, c)));
  const rights = h('input', { type: 'checkbox', id: 'rights' });
  const prog = h('div', { class: 'progress', hidden: true }, h('i'));
  const draftBtn = h('button', { class: 'btn ghost', type: 'button' }, 'Save as draft');
  const pubBtn = h('button', { class: 'btn coral', type: 'button' }, 'Publish video!');
  const mine = h('div', { class: 'mine' });

  function submit(status) {
    if (!file) return toast('Choose a video file first.', true);
    if (!titleIn.value.trim()) { titleIn.focus(); return toast('Add a title.', true); }
    if (!rights.checked) return toast('Please confirm the video is yours or you have permission.', true);
    const cat = chips.map(c => c.querySelector('input')).find(i => i.checked).value;
    const qs = new URLSearchParams({ title: titleIn.value.trim(), description: descIn.value.trim(), category: cat, visibility: visSel.value, status, filename: file.name, duration: String(duration || 0), rights: '1' });
    draftBtn.disabled = pubBtn.disabled = true; prog.hidden = false; prog.firstChild.style.width = '0';
    xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/videos?' + qs);
    xhr.setRequestHeader('X-Requested-With', 'bidyo');
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = e => { if (e.lengthComputable) prog.firstChild.style.width = Math.round((e.loaded / e.total) * 100) + '%'; };
    const fail = msg => { draftBtn.disabled = pubBtn.disabled = false; prog.hidden = true; toast(msg, true); xhr = null; };
    xhr.onerror = () => fail('Upload failed. Check your connection and try again.');
    xhr.onload = async () => {
      let data = {}; try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status === 401) { state.me = null; state.next = '#/upload'; toast('Your session ended. Please sign in again.', true); location.hash = '#/login'; return; }
      if (xhr.status !== 201) return fail(data.error || 'Upload failed.');
      const vid = data.video;
      if (thumbBlob) { try { await api(`/videos/${vid.id}/thumb`, { method: 'PUT', raw: thumbBlob }); } catch {} }
      xhr = null; prog.hidden = true; draftBtn.disabled = pubBtn.disabled = false;
      toast(status === 'draft' ? 'Saved as draft.' : 'Your video is live!');
      file = null; thumbBlob = null; duration = 0; titleIn.value = ''; descIn.value = ''; rights.checked = false; renderDrop(); loadMine();
      if (status === 'published' && visSel.value !== 'private') location.hash = `#/watch/${vid.id}`;
    };
    // Safari/Chrome set Content-Type from the Blob; we send the raw file as the request body (streamed to disk server-side).
    xhr.send(file);
  }
  draftBtn.onclick = () => submit('draft'); pubBtn.onclick = () => submit('published');
  // sending the Content-Type header explicitly with a Blob is fine; XHR uses ours.

  async function loadMine() {
    try {
      const { videos } = await api('/my/videos');
      mine.replaceChildren(h('h2', {}, 'Your videos'),
        ...(videos.length ? videos.map(v => h('div', { class: 'vrow' }, thumb(v),
          h('div', {}, h('a', { href: `#/watch/${v.id}` }, v.title),
            h('small', {}, h('span', { class: 'tag' + (v.status === 'draft' ? ' draft' : '') }, v.status === 'draft' ? 'Draft' : 'Published'), h('span', { class: 'tag vis' }, v.visibility), `${fmtViews(v.views)} · ${v.category}`)),
          h('div', { class: 'acts' },
            h('button', { class: 'btn sm ghost', onclick: async () => { try { await api('/videos/' + v.id, { method: 'PATCH', body: { status: v.status === 'draft' ? 'published' : 'draft' } }); loadMine(); } catch (e) { toast(e.message, true); } } }, v.status === 'draft' ? 'Publish' : 'Unpublish'),
            h('button', { class: 'btn sm coral', onclick: async () => { if (!confirm(`Delete "${v.title}"? This can't be undone.`)) return; try { await api('/videos/' + v.id, { method: 'DELETE' }); toast('Video deleted.'); loadMine(); } catch (e) { toast(e.message, true); } } }, 'Delete'))))
          : [h('p', { style: 'color:var(--muted)' }, 'Videos you upload will appear here.')]));
    } catch (e) { if (e.status === 401) { state.me = null; location.hash = '#/login'; } }
  }

  renderDrop();
  const form = h('div', { class: 'form-card' },
    h('label', { class: 'field', for: 'title' }, h('span', {}, 'Title'), titleIn),
    h('label', { class: 'field', for: 'desc' }, h('span', {}, 'Video description'), descIn),
    h('div', { class: 'two' },
      h('label', { class: 'field', for: 'vis' }, h('span', {}, 'Who can watch?'), visSel),
      h('div', { class: 'field', role: 'radiogroup', 'aria-label': 'Category' }, h('span', { style: 'display:block;font-weight:800;margin-bottom:6px' }, 'Category'), h('div', { class: 'chips' }, chips))),
    h('label', { class: 'check', for: 'rights' }, rights, 'This video is mine, or I have permission to upload it.'));

  setPage('', topbar({ light: true, search: false, nav: false }),
    h('main', { class: 'page', style: 'max-width:1300px' }, h('div', { class: 'upload-grid' },
      h('div', {}, h('h1', {}, 'Upload a video'), h('p', { class: 'lead' }, "Just drop it in, then we'll sort out the details."), drop, fileInput, form, prog,
        h('div', { class: 'actions' }, draftBtn, pubBtn), mine),
      h('aside', {},
        h('section', { class: 'tips' }, h('h2', {}, 'Tips to get noticed'), h('ul', {}, h('li', {}, 'Short title, clear content.'), h('li', {}, 'Bright thumbnail.'), h('li', {}, 'Start with the best part.'))),
        h('section', { class: 'account' }, h('h2', {}, 'Your account'), h('dl', {}, h('div', {}, h('dt', {}, 'Gmail'), h('dd', {}, state.me.email))),
          h('button', { class: 'link', onclick: logout }, 'Log out'))))));
  loadMine();
}

/* Reads duration + a thumbnail frame from the chosen file, entirely in the browser. */
function probe(url) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto'; v.playsInline = true; v.src = url;
    const done = fn => arg => { clearTimeout(timer); v.removeAttribute('src'); v.load(); fn(arg); };
    const ok = done(resolve), no = done(reject);
    const timer = setTimeout(() => no(new Error('timeout')), 10000);
    v.addEventListener('error', () => no(new Error('bad video')));
    v.addEventListener('loadedmetadata', () => { v.currentTime = Math.min(1, (v.duration || 1) / 3); });
    v.addEventListener('seeked', () => {
      try {
        const w = 640, hh = Math.round(w * (v.videoHeight || 360) / (v.videoWidth || 640));
        const c = document.createElement('canvas'); c.width = w; c.height = hh;
        c.getContext('2d').drawImage(v, 0, 0, w, hh);
        c.toBlob(b => ok({ duration: isFinite(v.duration) ? v.duration : 0, thumb: b && b.size < 380 * 1024 ? b : null }), 'image/jpeg', 0.75);
      } catch (e) { ok({ duration: isFinite(v.duration) ? v.duration : 0, thumb: null }); }
    }, { once: true });
  });
}

/* ---------- static pages ---------- */
function pageProse(title, paragraphs) {
  setTitle(title);
  setPage('dark', topbar({ search: false, nav: false, back: true }), h('main', { class: 'page prose' }, h('h1', {}, title), paragraphs.map(([hd, p]) => [h('h2', {}, hd), h('p', {}, p)])));
}

/* ============================ auth + router ============================ */
async function logout() {
  try { await api('/auth/logout', { method: 'POST' }); } catch {}
  state.me = null; toast('You\'re logged out.'); location.hash = '#/'; route();
}

async function route() {
  cleanup.forEach(fn => { try { fn(); } catch {} }); cleanup = [];
  const hash = location.hash || '#/';
  let m;
  try {
    if (hash === '#/' || hash === '#') return await pageHome();
    if ((m = /^#\/c\/(\w+)$/.exec(hash)) && state.config.categories.includes(m[1])) return await pageList(m[1], '&category=' + encodeURIComponent(m[1]));
    if ((m = /^#\/search\/(.+)$/.exec(hash))) { const q = decodeURIComponent(m[1]); return await pageList(`Results for “${q}”`, '&q=' + encodeURIComponent(q)); }
    if ((m = /^#\/watch\/([a-f0-9]{16})$/.exec(hash))) return await pageWatch(m[1]);
    if (hash === '#/login') return pageLogin();
    if (hash === '#/verify') return pageVerify();
    if (hash === '#/upload') return await pageUpload();
    if (hash === '#/terms') return pageProse('Terms', [['Be nice, share your own stuff', 'Only upload videos that are yours or that you have permission to share. Videos that are illegal, hateful, or harmful will be removed.'], ['Your account', 'Your account is tied to your verified Gmail address. Keep your codes private.']]);
    if (hash === '#/privacy') return pageProse('Privacy Policy', [['What we store', 'Your Gmail address (to verify you and show your name), the videos you upload, and a sign-in cookie so you stay logged in.'], ['What we never do', 'We never ask for your password, and we never post anything for you. Watching requires no account and no personal data.']]);
    location.hash = '#/';
  } catch (e) { console.error(e); toast('Something went wrong.', true); }
}

(async function init() {
  try { const [c, me] = await Promise.all([api('/config'), api('/me')]); Object.assign(state.config, c); state.me = me.user; } catch {}
  window.addEventListener('hashchange', route);
  route();
})();
