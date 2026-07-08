# Telegram → yt-dlp → Google Drive Bot

Ekta Telegram bot ja **je kono video/audio link** (YouTube, TikTok, Instagram, Twitter, Facebook, Vimeo, Reddit, xHamster, xVideos, PornHub — **1000+ sites** yt-dlp support kore) download kore tomar **Google Drive-e upload** kore share link diye dey.

---

## Ki ki lagbe

1. **Telegram Bot Token** — @BotFather theke `/newbot` diye.
2. **Google Cloud OAuth credentials** (client_id + client_secret + refresh_token).
3. **Railway account** (free tier cholbe start-e).

---

## Step 1: Telegram bot toiri

1. Telegram-e @BotFather kholo → `/newbot` → nam + username dao.
2. Je token pabe (jemn `123456:ABC-...`) — copy kore rakho.

---

## Step 2: Google Drive OAuth setup (ekbar-i)

1. https://console.cloud.google.com/ → **New Project** toiri koro.
2. **APIs & Services → Library** → search "Google Drive API" → **Enable**.
3. **APIs & Services → OAuth consent screen**:
   - User type: **External**
   - App name + tomar Gmail dao
   - **Test users** section-e tomar nijer Gmail add koro (very important!)
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Desktop app**
   - Name: kichu ekta (jemn "dl-bot")
   - **Download JSON** → save it as `client_secret.json` inside `railway-bot/` folder.
5. Tomar local machine-e (Python installed):
   ```bash
   cd railway-bot
   pip install google-auth-oauthlib
   python get_refresh_token.py
   ```
6. Browser open hobe → tomar Google account diye login koro → Drive access allow koro.
7. Terminal-e ekta output pabe emn:
   ```
   GOOGLE_CLIENT_ID=xxxxx.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=xxxxx
   GOOGLE_REFRESH_TOKEN=1//0xxxxx
   ```
   Ei tinta save kore rakho.

**Optional — specific folder-e upload korte chaile:**
Drive-e ekta folder banao → folder open koro → URL theke folder ID copy koro:
`https://drive.google.com/drive/folders/<THIS_IS_THE_ID>`

---

## Step 3: Railway-e deploy

1. https://railway.app/ → login (GitHub diye).
2. **New Project → Deploy from GitHub repo** → ei project select koro.
   *(Athoba: New Project → Empty → local theke `railway up` CLI diye push.)*
3. **Root Directory** set koro: `railway-bot`
4. Service **Settings → Variables** e ei env vars add koro:

   | Variable | Value |
   |---|---|
   | `BOT_TOKEN` | Step 1 er Telegram token |
   | `GOOGLE_CLIENT_ID` | Step 2 er client_id |
   | `GOOGLE_CLIENT_SECRET` | Step 2 er client_secret |
   | `GOOGLE_REFRESH_TOKEN` | Step 2 er refresh_token |
   | `GOOGLE_DRIVE_FOLDER_ID` | *(optional)* folder ID |
   | `ALLOWED_USER_IDS` | *(optional)* tomar Telegram ID (@userinfobot theke), comma-separated. Empty rakhle sobai use korte parbe |
   | `YT_DLP_COOKIES` | *(optional)* cookies.txt file er full content, jodi kono site login-required hoy |

5. Deploy hobe automatically. Logs-e `Bot starting…` dekhle ready.

---

## Step 4: Use koro

1. Telegram-e tomar bot open koro → `/start` chapo.
2. Je kono video URL pathao (YouTube, xHamster, TikTok, jai hok).
3. Bot download korbe → Drive-e upload korbe → shareable link pathabe.

---

## Notes / limits

- **Railway free tier**: 500 hours/month + ~1 GB disk. Boro video (10 GB+) upload er somoy disk full hote pare — sei khetre paid plan lagbe.
- **File size**: Drive-e upload er kono limit nei (except your Drive quota).
- **Speed**: Railway → Google Drive khub fast, karon dutoi US datacenter-e.
- **Cookies**: Age-restricted YouTube video ba private content-er jonno `YT_DLP_COOKIES` env var-e cookies.txt content paste koro. [Guide](https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp).
- **Private bot**: `ALLOWED_USER_IDS`-e sudhu nijer ID rakho, tahole onno keu use korte parbe na.

---

## Local test (Docker)

```bash
cd railway-bot
cp .env.example .env
# fill in values
docker build -t dl-bot .
docker run --rm --env-file .env dl-bot
```
