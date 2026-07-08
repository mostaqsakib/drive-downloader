"""
FastAPI service: URL -> yt-dlp download -> Google Drive upload -> return share link.
Called from the DriveGrabber web app via a shared secret token.
"""

import logging
import os
import shutil
import tempfile
import time
from pathlib import Path
from typing import Optional

import yt_dlp
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from google.auth.transport.requests import Request as GoogleRequest
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload
from pydantic import BaseModel, Field

logging.basicConfig(
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger("dl-api")

API_SECRET = os.environ["API_SECRET_TOKEN"]
GOOGLE_CLIENT_ID = os.environ["GOOGLE_CLIENT_ID"]
GOOGLE_CLIENT_SECRET = os.environ["GOOGLE_CLIENT_SECRET"]
GOOGLE_REFRESH_TOKEN = os.environ["GOOGLE_REFRESH_TOKEN"]
GOOGLE_DRIVE_FOLDER_ID = os.environ.get("GOOGLE_DRIVE_FOLDER_ID", "").strip() or None
YT_DLP_COOKIES = os.environ.get("YT_DLP_COOKIES", "").strip()
ALLOWED_ORIGINS = [
    o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",") if o.strip()
] or ["*"]

app = FastAPI(title="DriveGrabber API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)


class DownloadIn(BaseModel):
    url: str = Field(..., min_length=4, max_length=2048)
    mode: str = Field("auto", pattern="^(auto|audio|mute)$")
    quality: str = Field("1080", pattern="^(max|1080|720|480|360)$")
    cookies: Optional[str] = Field(None, max_length=200_000)



class DownloadOut(BaseModel):
    ok: bool
    name: str
    size_mb: float
    download_seconds: float
    upload_seconds: float
    view_link: Optional[str] = None
    file_id: str


# ---------- Google Drive ----------

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


def upload_to_drive(file_path: Path) -> dict:
    service = get_drive_service()
    metadata = {"name": file_path.name}
    if GOOGLE_DRIVE_FOLDER_ID:
        metadata["parents"] = [GOOGLE_DRIVE_FOLDER_ID]

    media = MediaFileUpload(
        str(file_path),
        resumable=True,
        chunksize=8 * 1024 * 1024,
    )
    request = service.files().create(
        body=metadata,
        media_body=media,
        fields="id, name, size, webViewLink, webContentLink",
    )
    response = None
    while response is None:
        _, response = request.next_chunk()

    try:
        service.permissions().create(
            fileId=response["id"],
            body={"role": "reader", "type": "anyone"},
            fields="id",
        ).execute()
    except Exception as e:
        logger.warning("Could not set public permission: %s", e)

    return response


# ---------- yt-dlp ----------

def build_ydl_opts(out_dir: Path, mode: str, quality: str, cookies_path: Optional[Path]) -> dict:
    if mode == "audio":
        fmt = "bestaudio/best"
        post = [{"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "192"}]
        merge = None
    elif mode == "mute":
        fmt = f"bv*[height<={quality}]/bv*" if quality != "max" else "bv*"
        post = []
        merge = "mp4"
    else:
        if quality == "max":
            fmt = "bv*+ba/b"
        else:
            fmt = f"bv*[height<={quality}]+ba/b[height<={quality}]/b"
        post = []
        merge = "mp4"

    opts = {
        "outtmpl": str(out_dir / "%(title).150B [%(id)s].%(ext)s"),
        "format": fmt,
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
    if merge:
        opts["merge_output_format"] = merge
    if post:
        opts["postprocessors"] = post
    if cookies_path:
        opts["cookiefile"] = str(cookies_path)
    return opts


def download_url(
    url: str,
    out_dir: Path,
    mode: str,
    quality: str,
    request_cookies: Optional[str] = None,
) -> Path:
    # Per-request cookies (from the web app) take priority over the
    # server-wide YT_DLP_COOKIES env fallback.
    cookies_path = None
    cookies_text = request_cookies if request_cookies else (YT_DLP_COOKIES or None)
    if cookies_text:
        cookies_path = out_dir / "cookies.txt"
        cookies_path.write_text(cookies_text)

    with yt_dlp.YoutubeDL(build_ydl_opts(out_dir, mode, quality, cookies_path)) as ydl:
        info = ydl.extract_info(url, download=True)
        if "requested_downloads" in info and info["requested_downloads"]:
            p = Path(info["requested_downloads"][0]["filepath"])
            if p.exists():
                return p
        files = [p for p in out_dir.iterdir() if p.is_file() and p.name != "cookies.txt"]
        if not files:
            raise RuntimeError("Download finished but no file found")
        return max(files, key=lambda p: p.stat().st_size)



# ---------- Routes ----------

@app.get("/")
def health():
    return {"ok": True, "service": "drivegrabber-api"}


@app.post("/download", response_model=DownloadOut)
def download(body: DownloadIn, x_api_token: str = Header(None)):
    if not x_api_token or x_api_token != API_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized")

    tmp_dir = Path(tempfile.mkdtemp(prefix="dl_"))
    try:
        t0 = time.time()
        file_path = download_url(body.url, tmp_dir, body.mode, body.quality, body.cookies)
        size_mb = file_path.stat().st_size / (1024 * 1024)
        dl_secs = time.time() - t0

        t1 = time.time()
        drive_file = upload_to_drive(file_path)
        up_secs = time.time() - t1

        return DownloadOut(
            ok=True,
            name=drive_file["name"],
            size_mb=round(size_mb, 2),
            download_seconds=round(dl_secs, 1),
            upload_seconds=round(up_secs, 1),
            view_link=drive_file.get("webViewLink") or drive_file.get("webContentLink"),
            file_id=drive_file["id"],
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("download failed")
        raise HTTPException(status_code=500, detail=str(e)[:400])
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
