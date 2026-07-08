"""
Telegram bot: any video/audio URL -> yt-dlp download -> upload to Google Drive.
Supports 1000+ sites via yt-dlp (YouTube, TikTok, Instagram, Twitter,
Facebook, Vimeo, xHamster, xVideos, PornHub, and more).
"""

import asyncio
import logging
import os
import re
import shutil
import tempfile
import time
from pathlib import Path
from typing import Optional

import yt_dlp
from google.auth.transport.requests import Request as GoogleRequest
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload
from telegram import Update
from telegram.constants import ChatAction, ParseMode
from telegram.ext import (
    Application,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

logging.basicConfig(
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger("dl-bot")

BOT_TOKEN = os.environ["BOT_TOKEN"]
ALLOWED_USER_IDS = {
    int(x) for x in os.environ.get("ALLOWED_USER_IDS", "").split(",") if x.strip()
}
GOOGLE_CLIENT_ID = os.environ["GOOGLE_CLIENT_ID"]
GOOGLE_CLIENT_SECRET = os.environ["GOOGLE_CLIENT_SECRET"]
GOOGLE_REFRESH_TOKEN = os.environ["GOOGLE_REFRESH_TOKEN"]
GOOGLE_DRIVE_FOLDER_ID = os.environ.get("GOOGLE_DRIVE_FOLDER_ID", "").strip() or None
YT_DLP_COOKIES = os.environ.get("YT_DLP_COOKIES", "").strip()

URL_RE = re.compile(r"https?://\S+")


# ---------------- Google Drive ----------------

def get_drive_service():
    creds = Credentials(
        token=None,
        refresh_token=GOOGLE_REFRESH_TOKEN,
        token_uri="https://oauth2.googleapis.com/token",
        client_id=GOOGLE_CLIENT_ID,
        client_secret=GOOGLE_CLIENT_SECRET,
        scopes=["https://www.googleapis.com/auth/drive.file"],
    )
    creds.refresh(GoogleRequest())
    return build("drive", "v3", credentials=creds, cache_discovery=False)


def upload_to_drive(
    file_path: Path,
    progress_cb=None,
) -> dict:
    service = get_drive_service()
    metadata = {"name": file_path.name}
    if GOOGLE_DRIVE_FOLDER_ID:
        metadata["parents"] = [GOOGLE_DRIVE_FOLDER_ID]

    media = MediaFileUpload(
        str(file_path),
        resumable=True,
        chunksize=8 * 1024 * 1024,  # 8 MB chunks
    )
    request = service.files().create(
        body=metadata,
        media_body=media,
        fields="id, name, size, webViewLink, webContentLink",
    )
    response = None
    last_pct = -5
    while response is None:
        status, response = request.next_chunk()
        if status and progress_cb:
            pct = int(status.progress() * 100)
            if pct - last_pct >= 10:
                last_pct = pct
                progress_cb(pct)

    # Make it viewable via link (optional; comment out to keep private)
    try:
        service.permissions().create(
            fileId=response["id"],
            body={"role": "reader", "type": "anyone"},
            fields="id",
        ).execute()
    except Exception as e:
        logger.warning("Could not set public permission: %s", e)

    return response


# ---------------- yt-dlp ----------------

def build_ydl_opts(out_dir: Path, cookies_path: Optional[Path]) -> dict:
    opts = {
        "outtmpl": str(out_dir / "%(title).150B [%(id)s].%(ext)s"),
        "format": "bv*+ba/b",
        "merge_output_format": "mp4",
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "restrictfilenames": True,
        "concurrent_fragment_downloads": 4,
        "retries": 5,
        "fragment_retries": 5,
        "http_headers": {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/128.0.0.0 Safari/537.36"
            )
        },
    }
    if cookies_path:
        opts["cookiefile"] = str(cookies_path)
    return opts


def download_url(url: str, out_dir: Path) -> Path:
    cookies_path = None
    if YT_DLP_COOKIES:
        cookies_path = out_dir / "cookies.txt"
        cookies_path.write_text(YT_DLP_COOKIES)

    with yt_dlp.YoutubeDL(build_ydl_opts(out_dir, cookies_path)) as ydl:
        info = ydl.extract_info(url, download=True)
        if "requested_downloads" in info and info["requested_downloads"]:
            return Path(info["requested_downloads"][0]["filepath"])
        # Fallback: pick largest file in out_dir
        files = [p for p in out_dir.iterdir() if p.is_file() and p.name != "cookies.txt"]
        if not files:
            raise RuntimeError("Download finished but no file found")
        return max(files, key=lambda p: p.stat().st_size)


# ---------------- Telegram handlers ----------------

def _is_allowed(user_id: int) -> bool:
    return not ALLOWED_USER_IDS or user_id in ALLOWED_USER_IDS


async def start(update: Update, _ctx: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "Hi! Ekta video/audio URL patha — ami download kore Google Drive-e "
        "upload kore link diye debo.\n\n"
        "Supported: YouTube, TikTok, Instagram, Twitter/X, Facebook, Vimeo, "
        "Reddit, Dailymotion, xHamster, xVideos, PornHub — 1000+ sites."
    )


async def handle_link(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    if not _is_allowed(user_id):
        await update.message.reply_text("Sorry, tumi eshoi bot use korte parbe na.")
        return

    text = update.message.text or ""
    match = URL_RE.search(text)
    if not match:
        await update.message.reply_text("Ekta valid URL diyo.")
        return
    url = match.group(0)

    status_msg = await update.message.reply_text(f"⏳ Downloading…\n`{url}`", parse_mode=ParseMode.MARKDOWN)
    await ctx.bot.send_chat_action(update.effective_chat.id, ChatAction.UPLOAD_DOCUMENT)

    tmp_dir = Path(tempfile.mkdtemp(prefix="dl_"))
    try:
        t0 = time.time()
        loop = asyncio.get_running_loop()
        file_path = await loop.run_in_executor(None, download_url, url, tmp_dir)
        size_mb = file_path.stat().st_size / (1024 * 1024)
        dl_secs = time.time() - t0

        await status_msg.edit_text(
            f"✅ Downloaded `{file_path.name}` ({size_mb:.1f} MB in {dl_secs:.0f}s)\n"
            f"☁️ Uploading to Google Drive…",
            parse_mode=ParseMode.MARKDOWN,
        )

        async def report(pct: int):
            try:
                await status_msg.edit_text(
                    f"☁️ Uploading to Drive… {pct}%\n`{file_path.name}`",
                    parse_mode=ParseMode.MARKDOWN,
                )
            except Exception:
                pass

        def sync_progress(pct: int):
            asyncio.run_coroutine_threadsafe(report(pct), loop)

        t1 = time.time()
        drive_file = await loop.run_in_executor(
            None, upload_to_drive, file_path, sync_progress
        )
        up_secs = time.time() - t1

        link = drive_file.get("webViewLink") or drive_file.get("webContentLink")
        await status_msg.edit_text(
            f"✅ *Done!*\n\n"
            f"📄 `{drive_file['name']}`\n"
            f"📦 {size_mb:.1f} MB\n"
            f"⬇️ {dl_secs:.0f}s   ☁️ {up_secs:.0f}s\n\n"
            f"🔗 [Open in Drive]({link})",
            parse_mode=ParseMode.MARKDOWN,
            disable_web_page_preview=True,
        )
    except Exception as e:
        logger.exception("Job failed")
        err = str(e)[:400]
        await status_msg.edit_text(f"❌ Failed:\n`{err}`", parse_mode=ParseMode.MARKDOWN)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def main():
    app = Application.builder().token(BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("help", start))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_link))
    logger.info("Bot starting…")
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
