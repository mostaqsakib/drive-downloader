## Architecture

```
[Browser UI on Lovable]
        ↓ (URL + quality)
[TanStack server fn] — holds VPS_API_TOKEN
        ↓ HTTPS
[Your VPS: Node.js + yt-dlp + rclone]
        ↓ rclone copy
[Your Google Drive]
```

Lovable holds the UI + a thin auth proxy. Your VPS does the heavy lifting (yt-dlp download + rclone upload to Drive). This is the only sane split — yt-dlp cannot run on Cloudflare Workers.

## What I'll build in this project

**Frontend (Lovable)**
- Homepage: URL input, quality selector (best / 1080p / 720p / 480p / audio-only mp3), "Download to Drive" button
- Jobs list: shows all submitted jobs with status (queued / downloading / uploading / done / failed), file name, Drive link, polls every 3s while active
- Toast notifications, clean dark UI, mobile-friendly
- SEO metadata + sitemap/robots

**Server (TanStack server functions)**
- `submitJob({ url, quality })` → POSTs to `${VPS_API_URL}/jobs` with bearer token
- `listJobs()` → GETs `${VPS_API_URL}/jobs`
- `getJob(id)` → GETs `${VPS_API_URL}/jobs/:id`
- `deleteJob(id)` → DELETEs
- Secrets: `VPS_API_URL`, `VPS_API_TOKEN`

**VPS bundle** (in `/vps/` folder — you deploy this)
- `install.sh` — installs Node 20, yt-dlp, ffmpeg, rclone; sets up systemd service
- `server.js` — Express API with:
  - Bearer-token auth
  - In-memory job queue (SQLite-backed for persistence)
  - `yt-dlp` spawn → download to `/tmp/downloads/<jobId>/`
  - `rclone copy` to `gdrive:RexovaanDownloads/`
  - Returns Drive shareable link
- `README.md` — step-by-step: rclone Drive OAuth setup, run install.sh, open firewall, point Lovable at the URL

## Tech details (for reference)

- Ubuntu 22.04+ / Debian 12
- yt-dlp latest (pip install)
- rclone with Google Drive remote named `gdrive`
- Node 20 + Express + better-sqlite3
- Nginx + Certbot for HTTPS (documented, optional)
- API token: 64-char random, stored in `/etc/rexovaan/env`

## After build

I'll ask you to add two secrets (`VPS_API_URL`, `VPS_API_TOKEN`) and walk you through the VPS install (~5 min). Then publish automatically.

Ekhon shuru kori?