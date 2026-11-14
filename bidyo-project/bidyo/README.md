# Bidyo 🎬  — Upload. Share. Have fun!

Video sharing site. **Panonood = libre, walang account.** Ang **pag-log in (Gmail + 6-digit OTP) ay kailangan lang kung mag-a-upload.**

- **Zero dependencies** — Node.js 22.5+ lang ang kailangan (built-in SQLite). Walang `npm install`.
- **Multi-user** — SQLite (WAL mode), streamed uploads (hindi nilo-load sa RAM), HTTP Range streaming para sa video seeking, rate limiting.
- **UI** — ayon sa Logo & Brand Kit at 5 screens (Home, Watch, Login, Verify OTP, Upload). Mga reference PNG nasa `design/`.

## Mabilis na takbo (local)

```bash
cd bidyo
npm run dev          # http://localhost:3000   (OTP lalabas sa console at sa verify page — dev lang)
npm test             # smoke tests (auth, OTP, upload, streaming, permissions)
```

## I-online (production)

1. **Kumuha ng Gmail App Password** (para makapag-send ng OTP emails):
   Google Account → Security → turn on *2-Step Verification* → *App passwords* → gumawa ng isa.
2. `cp .env.example .env` at ilagay ang `SMTP_USER` (sender Gmail) at `SMTP_PASS` (app password).
3. Takbo:
   - **Docker:** `docker compose up -d --build` (naka-persist ang data sa volume `bidyo-data`)
   - **o direkta:** `NODE_ENV=production npm start`
4. **Lagyan ng HTTPS** (kailangan sa production para sa secure cookie): gamitin ang `Caddyfile.example`
   (auto-HTTPS) o nginx/Cloudflare. Itakda ang `TRUST_PROXY=1`. Sa nginx, i-set ang `client_max_body_size 600m;`.
5. Pwedeng i-host sa kahit anong VPS (DigitalOcean, Hetzner, AWS Lightsail…) o Railway/Render/Fly na may **persistent disk** (para sa `DATA_DIR`).

> ⚠️ Huwag ilagay ang app sa host na may *ephemeral* disk nang walang volume — mabubura ang mga video at accounts tuwing mag-restart.

## Paano gumagana

| Bahagi | Detalye |
|---|---|
| Panonood | Lahat ng public/published videos — walang login. Search, categories, Up next, view count. |
| Login | Gmail lang (`gmail.com` / `googlemail.com`). Dots at `+tags` ay iisang account lang. |
| OTP | 6 digits, **5 minuto** bago mag-expire, **single-use**, naka-hash (HMAC), **5 maling tries** max, 30s resend cooldown, max 5 codes/oras bawat email, IP rate limit. |
| Session | Random 256-bit token, hash lang ang naka-store, `HttpOnly` + `SameSite=Lax` cookie, 30 araw. |
| Upload | MP4 / WebM / MOV, default max 500 MB (`MAX_UPLOAD_MB`), may magic-byte check, progress bar, thumbnail na kinukuha sa browser, Draft / Publish, Public / Unlisted / Private. |
| Manage | "Your videos" sa upload page: i-publish/i-unpublish, i-delete. |
| Seguridad | CSRF header + SameSite, CSP, walang `innerHTML` ng user text (XSS-safe), path-traversal guard, parameterized SQL. |

## Istruktura

```
server.js            routes, auth/OTP, upload, streaming, static
lib/config.js        .env + settings        lib/db.js      SQLite schema
lib/mailer.js        SMTP client (Gmail)
public/              index.html, css/app.css, js/app.js (SPA), img/logo.svg
test/smoke.test.js   end-to-end tests
design/              original UI + brand PNGs
```

## Mga tala / limitasyon

- **Facebook:** nasa orihinal na disenyo ang "Connect Facebook", pero ayon sa hiling mo **Gmail OTP lang** ang login, kaya wala ito. Kung gusto mo, madadagdag ang Facebook Login (kailangan ng Facebook App ID/Secret).
- **Scaling:** kaya ng isang server ang maraming sabay-sabay na user. Para sa napakalaking traffic, ilipat ang `data/uploads` sa S3/R2 + CDN at ang rate limiter sa Redis (hiwalay na pagpapalawak).
- Walang transcoding — ang browser mismo ang nagpe-play kaya MP4 (H.264/AAC) ang pinaka-compatible.
- Walang laman ang site sa simula; ang mga video ay galing sa mga nag-upload.
