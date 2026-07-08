"""
FastAPI service: URL -> yt-dlp download -> Google Drive upload -> return share link.
Called from the DriveGrabber web app via a shared secret token.
"""

import logging
import os
import re
import shutil
import tempfile
import time
from pathlib import Path
from typing import Optional
from urllib.parse import urlsplit, urlunsplit

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

def normalize_download_url(url: str) -> str:
    """Clean browser-only fragments and add a scheme when users paste bare URLs."""
    cleaned = url.strip()
    if cleaned.startswith("//"):
        cleaned = f"https:{cleaned}"
    elif "://" not in cleaned:
        cleaned = f"https://{cleaned}"

    parts = urlsplit(cleaned)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, parts.query, ""))


def mirror_host_aliases(host: str) -> list[str]:
    """Return equivalent hosts for known numbered mirrors."""
    normalized = host.strip().lstrip(".").lower()
    aliases = {normalized}
    collapsed = re.sub(r"^([a-z]+?)\d+(\.[a-z.]+)$", r"\1\2", normalized)
    aliases.add(collapsed)
    if collapsed == "faphouse.com":
        aliases.update({"faphouse.com", "faphouse2.com"})
    return [h for h in aliases if h]


def expand_cookie_domains(cookies_text: str) -> str:
    """Duplicate Netscape cookie rows across known mirror domains.

    Browser cookies exported for faphouse.com are not sent to faphouse2.com by
    yt-dlp, and vice versa. These mirrors share the same session, so duplicate
    the cookie rows before passing them to yt-dlp.
    """
    lines: list[str] = []
    seen: set[str] = set()
    for line in cookies_text.splitlines():
        variants = [line]
        if line and not line.startswith("#") and "\t" in line:
            parts = line.split("\t")
            if len(parts) >= 7:
                original_domain = parts[0]
                leading_dot = original_domain.startswith(".")
                for alias in mirror_host_aliases(original_domain):
                    alias_parts = parts.copy()
                    alias_parts[0] = f".{alias}" if leading_dot else alias
                    variants.append("\t".join(alias_parts))
        for variant in variants:
            if variant not in seen:
                seen.add(variant)
                lines.append(variant)
    return "\n".join(lines) + ("\n" if cookies_text.endswith("\n") else "")


def candidate_download_urls(url: str) -> list[str]:
    """Try the pasted URL first, then known mirror/original host variants."""
    primary = normalize_download_url(url)
    parts = urlsplit(primary)
    host = parts.netloc.lower()
    mirror_hosts = {
        "faphouse2.com": "faphouse.com",
        "www.faphouse2.com": "www.faphouse.com",
    }
    candidates = [primary]
    if host in mirror_hosts:
        mirrored = urlunsplit((parts.scheme, mirror_hosts[host], parts.path, parts.query, ""))
        candidates.append(mirrored)
    return list(dict.fromkeys(candidates))


def is_unsupported_error(error: Exception) -> bool:
    text = str(error).lower()
    return "unsupported url" in text or "no suitable extractor" in text

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
            ),
            "Accept-Language": "en-US,en;q=0.9",
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
        cookies_path.write_text(expand_cookie_domains(cookies_text), encoding="utf-8")

    def _run(attempt_url: str, opts: dict) -> Optional[Path]:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(attempt_url, download=True)
            if "requested_downloads" in info and info["requested_downloads"]:
                p = Path(info["requested_downloads"][0]["filepath"])
                if p.exists():
                    return p
            files = [
                p
                for p in out_dir.iterdir()
                if p.is_file() and p.name != "cookies.txt" and not p.name.endswith(".part")
            ]
            if not files:
                return None
            return max(files, key=lambda p: p.stat().st_size)

    base_opts = build_ydl_opts(out_dir, mode, quality, cookies_path)
    last_error: Optional[Exception] = None

    for attempt_url in candidate_download_urls(url):
        try:
            result = _run(attempt_url, base_opts)
            if result:
                return result
        except yt_dlp.utils.UnsupportedError as e:
            last_error = e
        except yt_dlp.utils.DownloadError as e:
            last_error = e
            if not is_unsupported_error(e):
                logger.info("Normal extractor failed for %s; trying generic fallback: %s", attempt_url, e)

        # Fallback: force generic extractor — grabs whatever <video>/HLS/DASH
        # source is on the page, works for many niche/mirror sites yt-dlp
        # doesn't officially support.
        logger.info("Falling back to generic extractor for %s", attempt_url)
        generic_opts = {**base_opts, "force_generic_extractor": True}
        try:
            result = _run(attempt_url, generic_opts)
            if result:
                return result
        except Exception as e:
            last_error = e
            logger.info("Generic extractor failed for %s: %s", attempt_url, e)

    if last_error:
        raise last_error
    raise RuntimeError("Download finished but no file found")




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
        detail = str(e).strip() or e.__class__.__name__
        raise HTTPException(status_code=500, detail=detail[:400])
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
