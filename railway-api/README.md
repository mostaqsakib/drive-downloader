# DriveGrabber Railway API

FastAPI service that takes a video URL, downloads with **yt-dlp** (1000+ sites: YouTube, TikTok, Instagram, Twitter/X, Facebook, Vimeo, Reddit, xHamster, xVideos, PornHub…) and uploads the file to **Google Drive**. The DriveGrabber web app calls this API using a shared secret token.

## 1. Get Google Drive credentials (one-time, local)

```bash
cd railway-api
pip install google-auth-oauthlib
# Put your OAuth Desktop client_secret.json here
python get_refresh_token.py
```

Copy the printed `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`.

## 2. Deploy to Railway

1. Push this repo (or just the `railway-api/` folder) to GitHub.
2. Railway → **New Project** → **Deploy from GitHub repo** → pick the repo.
3. If needed, set **Root Directory** to `railway-api`.
4. Add env vars (Variables tab):
   - `API_SECRET_TOKEN` — long random string (`openssl rand -hex 32`). Same value goes into the web app.
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `GOOGLE_REFRESH_TOKEN`
   - `GOOGLE_DRIVE_FOLDER_ID` *(optional — Drive folder to upload into)*
   - `ALLOWED_ORIGINS` *(optional — e.g. `https://your-app.lovable.app`)*
   - `YT_DLP_COOKIES` *(optional — cookies.txt content for sites needing login)*
5. Deploy. Railway will give you a public URL like `https://drivegrabber-api-production.up.railway.app`.

## 3. Wire into the web app

In the Lovable web app, add these two secrets (Project Settings → Secrets):

- `RAILWAY_API_URL` = your Railway URL (e.g. `https://drivegrabber-api-production.up.railway.app`)
- `API_SECRET_TOKEN` = same value as on Railway

## Test

```bash
curl -X POST "$RAILWAY_API_URL/download" \
  -H "Content-Type: application/json" \
  -H "X-Api-Token: $API_SECRET_TOKEN" \
  -d '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","mode":"auto","quality":"720"}'
```

Returns JSON with the Google Drive `view_link`.
