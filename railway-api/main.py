"""
FastAPI service: URL -> yt-dlp download -> Google Drive upload -> return share link.
Called from the DriveGrabber web app via a shared secret token.
"""

import logging
import json
import hashlib
import html as html_lib
import http.cookiejar
import os
import re
import shutil
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional
from urllib.parse import unquote, urlsplit, urlunsplit
import urllib.error
import urllib.parse
import urllib.request

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
FAPHOUSE_EMAIL = os.environ.get("FAPHOUSE_EMAIL", "").strip()
FAPHOUSE_PASSWORD = os.environ.get("FAPHOUSE_PASSWORD", "").strip()
ALLOWED_ORIGINS = [
    o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",") if o.strip()
] or ["*"]
SESSION_COOKIE_EXPIRES = 4102444799  # 2099-12-31: keep browser session cookies usable in server-side requests

# In-memory cache: cookies_text keyed by email, with expiry timestamp
_FAPHOUSE_LOGIN_CACHE: dict[str, tuple[str, float]] = {}
_FAPHOUSE_LOGIN_TTL = 60 * 25  # 25 minutes

# In-memory Drive job registry. Keeps long downloads off fragile browser/server
# HTTP connections; the web app starts a job, then polls short status requests.
_DOWNLOAD_JOBS: dict[str, dict] = {}
_DOWNLOAD_JOBS_LOCK = threading.Lock()
_DOWNLOAD_JOB_TTL = 60 * 60

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
    quality: str = Field("max", pattern="^(max|1080|720|480|360)$")
    cookies: Optional[str] = Field(None, max_length=1_000_000)
    client_job_id: Optional[str] = Field(None, alias="clientJobId", max_length=120)


class CookieCheckIn(BaseModel):
    url: str = Field(..., min_length=4, max_length=2048)
    cookies: Optional[str] = Field(None, max_length=1_000_000)



class DownloadOut(BaseModel):
    ok: bool
    name: str
    size_mb: float
    download_seconds: float
    upload_seconds: float
    view_link: Optional[str] = None
    file_id: str


class CookieCheckOut(BaseModel):
    ok: bool
    status: str
    message: str
    matched_cookie_rows: int = 0
    active_cookie_rows: int = 0
    expired_cookie_rows: int = 0
    premium: Optional[bool] = None
    allowed: Optional[bool] = None
    login_detected: Optional[bool] = None


class DownloadStartOut(BaseModel):
    ok: bool
    job_id: str
    status: str


class DownloadStatusOut(BaseModel):
    ok: bool
    job_id: str
    status: str
    result: Optional[DownloadOut] = None
    error: Optional[str] = None


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
    aliases = [normalized]
    collapsed = re.sub(r"^([a-z]+?)\d+(\.[a-z.]+)$", r"\1\2", normalized)
    if collapsed not in aliases:
        aliases.append(collapsed)
    if collapsed == "faphouse.com":
        for alias in ("faphouse.com", "faphouse2.com"):
            if alias not in aliases:
                aliases.append(alias)
    return [h for h in aliases if h]


def _netscape_cookie_row(
    domain: str,
    include_subdomains: str,
    path: str,
    secure: str,
    expires: str,
    name: str,
    value: str,
    *,
    http_only: bool = False,
) -> Optional[str]:
    domain = (domain or "").strip()
    name = (name or "").strip()
    if not domain or not name:
        return None
    include_subdomains = "TRUE" if str(include_subdomains).upper() == "TRUE" or domain.startswith(".") else "FALSE"
    secure = "TRUE" if str(secure).upper() == "TRUE" else "FALSE"
    try:
        expiry_int = int(float(expires or 0))
    except ValueError:
        expiry_int = 0
    if expiry_int <= 0:
        expiry_int = SESSION_COOKIE_EXPIRES
    row = "\t".join([
        domain,
        include_subdomains,
        path or "/",
        secure,
        str(expiry_int),
        name,
        value or "",
    ])
    return f"#HttpOnly_{row}" if http_only else row


def normalize_cookie_text(cookies_text: str, *, include_header: bool = True) -> str:
    """Accept Netscape, space-separated Netscape, or browser JSON cookies and emit Netscape rows."""
    rows: list[str] = []
    stripped = (cookies_text or "").strip()
    if not stripped:
        return ""

    try:
        parsed = json.loads(stripped)
        raw_rows = parsed.get("cookies") if isinstance(parsed, dict) else parsed
        if isinstance(raw_rows, list):
            for item in raw_rows:
                if not isinstance(item, dict):
                    continue
                domain = str(item.get("domain") or item.get("host") or "").strip()
                name = str(item.get("name") or "").strip()
                value = str(item.get("value") or "")
                expiry = item.get("expirationDate") or item.get("expires") or item.get("expiry") or 0
                if item.get("session") is True:
                    expiry = SESSION_COOKIE_EXPIRES
                row = _netscape_cookie_row(
                    domain,
                    "TRUE" if domain.startswith(".") else "FALSE",
                    str(item.get("path") or "/"),
                    "TRUE" if bool(item.get("secure")) else "FALSE",
                    str(expiry or 0),
                    name,
                    value,
                    http_only=bool(item.get("httpOnly") or item.get("http_only")),
                )
                if row:
                    rows.append(row)
            if rows:
                prefix = "# Netscape HTTP Cookie File\n" if include_header else ""
                return prefix + "\n".join(dict.fromkeys(rows)) + "\n"
    except Exception:
        pass

    for raw_line in cookies_text.splitlines():
        raw = raw_line.strip()
        if not raw:
            continue
        http_only = raw.startswith("#HttpOnly_")
        line = raw.removeprefix("#HttpOnly_") if http_only else raw
        if line.startswith("#"):
            continue
        parts = line.split("\t") if "\t" in line else line.split()
        if len(parts) < 7:
            continue
        row = _netscape_cookie_row(
            parts[0],
            parts[1],
            parts[2],
            parts[3],
            parts[4],
            parts[5],
            "\t".join(parts[6:]) if "\t" in line else " ".join(parts[6:]),
            http_only=http_only,
        )
        if row:
            rows.append(row)

    prefix = "# Netscape HTTP Cookie File\n" if include_header else ""
    return prefix + "\n".join(dict.fromkeys(rows)) + ("\n" if rows else "")


def expand_cookie_domains(cookies_text: str) -> str:
    """Duplicate Netscape cookie rows across known mirror domains.

    Browser cookies exported for faphouse.com are not sent to faphouse2.com by
    yt-dlp, and vice versa. These mirrors share the same session, so duplicate
    the cookie rows before passing them to yt-dlp.
    """
    normalized = normalize_cookie_text(cookies_text)
    lines: list[str] = []
    seen: set[str] = set()
    for line in normalized.splitlines():
        variants = [line]
        http_only = line.startswith("#HttpOnly_")
        cookie_line = line.removeprefix("#HttpOnly_") if http_only else line
        if cookie_line and (http_only or not cookie_line.startswith("#")) and "\t" in cookie_line:
            parts = cookie_line.split("\t")
            if len(parts) >= 7:
                original_domain = parts[0]
                leading_dot = original_domain.startswith(".")
                for alias in mirror_host_aliases(original_domain):
                    alias_parts = parts.copy()
                    alias_parts[0] = f".{alias}" if leading_dot else alias
                    variant = "\t".join(alias_parts)
                    variants.append(f"#HttpOnly_{variant}" if http_only else variant)
        for variant in variants:
            if variant not in seen:
                seen.add(variant)
                lines.append(variant)
    return "\n".join(lines) + ("\n" if lines else "")


def candidate_download_urls(url: str) -> list[str]:
    """Try the pasted URL first, then known mirror/original host variants."""
    primary = normalize_download_url(url)
    parts = urlsplit(primary)
    host = parts.netloc.lower()
    candidates = [primary]
    is_www = host.startswith("www.")
    bare_host = host.removeprefix("www.")
    for alias in mirror_host_aliases(bare_host):
        alias_host = f"www.{alias}" if is_www else alias
        if alias_host != host:
            candidates.append(urlunsplit((parts.scheme, alias_host, parts.path, parts.query, "")))
    return list(dict.fromkeys(candidates))


def is_unsupported_error(error: Exception) -> bool:
    text = str(error).lower()
    return "unsupported url" in text or "no suitable extractor" in text


def is_faphouse_url(url: str) -> bool:
    host = urlsplit(normalize_download_url(url)).netloc.lower().removeprefix("www.")
    return host in {"faphouse.com", "faphouse2.com"}


def cookie_domain_matches(cookie_domain: str, host: str) -> bool:
    domain_aliases = mirror_host_aliases(cookie_domain)
    host_aliases = mirror_host_aliases(host)
    return any(
        h == d or h.endswith("." + d) or d.endswith("." + h)
        for h in host_aliases
        for d in domain_aliases
    )


def cookie_row_stats(cookies_text: str, url: str) -> dict[str, int]:
    host = urlsplit(normalize_download_url(url)).netloc.lower().removeprefix("www.")
    now = int(time.time())
    matched = 0
    active = 0
    expired = 0
    for raw_line in normalize_cookie_text(cookies_text, include_header=False).splitlines():
        line = raw_line.removeprefix("#HttpOnly_")
        if not line or line.startswith("#") or "\t" not in line:
            continue
        parts = line.split("\t")
        if len(parts) < 7:
            continue
        domain = parts[0].strip().lstrip(".").lower().removeprefix("www.")
        if not domain or not cookie_domain_matches(domain, host):
            continue
        matched += 1
        try:
            expires = int(float(parts[4]))
        except ValueError:
            expires = 0
        if expires and expires < now:
            expired += 1
        else:
            active += 1
    return {"matched": matched, "active": active, "expired": expired}


def faphouse_origin(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}"


class PremiumAccessError(RuntimeError):
    pass


@dataclass
class ResolvedMedia:
    url: str
    title: Optional[str] = None


def clean_filename_stem(value: object) -> Optional[str]:
    """Return a filesystem-safe, human-readable stem while preserving Unicode."""
    if not isinstance(value, str):
        return None
    stem = html_lib.unescape(value).strip()
    if not stem:
        return None
    stem = re.sub(r"[\x00-\x1f\x7f]+", " ", stem)
    stem = re.sub(r'[<>:"/\\|?*]+', " ", stem)
    stem = re.sub(r"\s+", " ", stem).strip(" ._-")
    stem = re.sub(r"\s+[-–—|•]\s+(FapHouse|Faphouse).*?$", "", stem, flags=re.I).strip(" ._-")
    if not stem or re.fullmatch(r"_?TPL_?", stem, flags=re.I):
        return None
    return stem[:200].rstrip(" ._-") or None


def faphouse_title_from_page(webpage: str, page_url: str) -> Optional[str]:
    state = parse_view_state(webpage)
    video = state.get("video") if isinstance(state.get("video"), dict) else {}
    candidates: list[object] = []

    for source in (video, state):
        if not isinstance(source, dict):
            continue
        for key in (
            "title",
            "videoTitle",
            "video_title",
            "name",
            "displayName",
            "displayTitle",
            "seoTitle",
        ):
            candidates.append(source.get(key))

    for pattern in (
        r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']+)["\']',
        r'<meta[^>]+name=["\']twitter:title["\'][^>]+content=["\']([^"\']+)["\']',
        r'<title[^>]*>(.*?)</title>',
    ):
        match = re.search(pattern, webpage, flags=re.I | re.S)
        if match:
            candidates.append(match.group(1))

    path_slug = unquote(urlsplit(page_url).path.rstrip("/").split("/")[-1])
    if path_slug and not re.fullmatch(r"[A-Za-z0-9_-]{4,14}", path_slug):
        candidates.append(path_slug.replace("-", " ").replace("_", " "))

    for candidate in candidates:
        stem = clean_filename_stem(candidate)
        if stem:
            return stem
    return None


def request_with_cookiefile(
    url: str,
    cookies_path: Optional[Path],
    *,
    data: Optional[dict] = None,
    referer: Optional[str] = None,
) -> str:
    handlers = []
    if cookies_path:
        jar = http.cookiejar.MozillaCookieJar(str(cookies_path))
        jar.load(ignore_discard=True, ignore_expires=True)
        handlers.append(urllib.request.HTTPCookieProcessor(jar))

    payload = json.dumps(data).encode("utf-8") if data is not None else None
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/128.0.0.0 Safari/537.36"
        ),
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "application/json, text/plain, */*" if data is not None else "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }
    if referer:
        headers["Referer"] = referer
    if data is not None:
        headers["Content-Type"] = "application/json"
        headers["X-Requested-With"] = "XMLHttpRequest"
        headers["Origin"] = faphouse_origin(url)

    opener = urllib.request.build_opener(*handlers)
    req = urllib.request.Request(url, data=payload, headers=headers, method="POST" if data is not None else "GET")
    with opener.open(req, timeout=30) as response:
        return response.read().decode("utf-8", "ignore")


def parse_view_state(webpage: str) -> dict:
    match = re.search(
        r'<script[^>]+id=["\']view-state-data["\'][^>]*>(.*?)</script>',
        webpage,
        flags=re.I | re.S,
    )
    if not match:
        return {}
    try:
        return json.loads(html_lib.unescape(match.group(1)))
    except Exception:
        return {}


def media_urls_from_text(text: str) -> list[str]:
    haystacks = [text, html_lib.unescape(text).replace("\\/", "/")]
    urls: list[str] = []
    seen: set[str] = set()
    pattern = re.compile(r'https?:\\?/\\?/[^"\'<>\s\\]+?(?:\.m3u8|\.mpd|\.mp4)(?:\?[^"\'<>\s\\]*)?', re.I)
    for haystack in haystacks:
        for raw in pattern.findall(haystack):
            url = html_lib.unescape(raw).replace("\\/", "/")
            if url not in seen:
                seen.add(url)
                urls.append(url)
    return urls


def media_urls_from_state(state: dict) -> list[str]:
    """Recursively walk view-state JSON and collect any media URLs.
    Faphouse stores per-quality sources in nested arrays like
    video.sources / video.mediaDefinition / video.hls — mining those
    directly gives us every quality variant, not just what's inlined
    into the surrounding HTML."""
    urls: list[str] = []
    seen: set[str] = set()

    def walk(node):
        if isinstance(node, str):
            if re.match(r'https?://[^\s"\'<>]+\.(m3u8|mpd|mp4)(\?|$)', node, re.I):
                if node not in seen:
                    seen.add(node)
                    urls.append(node)
        elif isinstance(node, dict):
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(state)
    return urls


def is_preview_media_url(url: str) -> bool:
    lower = url.lower()
    return any(
        token in lower
        for token in (
            "/trailer/",
            "/preview/",
            "preview/",
            "preview_",
            "heatmap",
            "heat-preview",
            "thumb-preview",
        )
    )


def best_media_url(urls: list[str], require_full: bool) -> Optional[str]:
    if require_full:
        urls = [url for url in urls if not is_preview_media_url(url)]
    if not urls:
        return None

    def score(url: str) -> tuple[int, int, int, int]:
        lower = url.lower()
        full_score = 0 if is_preview_media_url(url) else 1
        # Prefer HLS master playlists (no quality digit) so yt-dlp picks
        # the highest variant itself instead of us locking onto a single mp4.
        is_master = 1 if (".m3u8" in lower and not re.search(r'(?<!\d)(2160|1440|1080|720|480|360)(?!\d)', lower)) else 0
        ext_score = 2 if ".m3u8" in lower else 1 if ".mp4" in lower else 0
        quality = max([int(q) for q in re.findall(r'(?<!\d)(2160|1440|1080|720|480|360)(?!\d)', lower)] or [0])
        return (full_score, is_master, quality, ext_score)

    return max(urls, key=score)


def resolve_faphouse_media_url(page_url: str, cookies_path: Optional[Path], require_premium: bool) -> Optional[ResolvedMedia]:
    webpage = request_with_cookiefile(page_url, cookies_path, referer=page_url)
    page_title = faphouse_title_from_page(webpage, page_url)
    state = parse_view_state(webpage)
    video = state.get("video") if isinstance(state.get("video"), dict) else {}
    is_premium = video.get("videoAccessType") == "premium"
    is_allowed = bool(video.get("videoViewAllowed"))

    if is_premium and not is_allowed and not cookies_path:
        raise PremiumAccessError(
            "Ei Faphouse video premium, kintu matching cookies pathano hoyni. Cookie vault-e fresh logged-in cookies.txt save kore retry korun."
        )

    if is_premium and not is_allowed:
        video_id = video.get("videoId")
        studio_id = video.get("studioId")
        if video_id:
            unlock_url = f"{faphouse_origin(page_url)}/api/unlock/video/{video_id}"
            try:
                unlock_text = request_with_cookiefile(
                    unlock_url,
                    cookies_path,
                    data={"studioId": studio_id},
                    referer=page_url,
                )
                unlock_state = parse_view_state(unlock_text)
                unlock_urls = media_urls_from_text(unlock_text) + media_urls_from_state(unlock_state)
                unlocked_media = best_media_url(unlock_urls, require_full=True)
                if unlocked_media:
                    logger.info("Faphouse unlock media chosen: %s", unlocked_media)
                    return ResolvedMedia(unlocked_media, page_title)
                webpage = request_with_cookiefile(page_url, cookies_path, referer=page_url)
                page_title = faphouse_title_from_page(webpage, page_url) or page_title
                state = parse_view_state(webpage)
                video = state.get("video") if isinstance(state.get("video"), dict) else {}
                is_allowed = bool(video.get("videoViewAllowed"))
            except urllib.error.HTTPError as e:
                if e.code in {401, 403}:
                    raise PremiumAccessError(
                        "Premium cookies diye Faphouse login unlock hocche na. Site-e login kore fresh cookies.txt export kore abar save korun."
                    ) from e
                raise

    if is_premium and not is_allowed:
        raise PremiumAccessError(
            "Premium cookies active na bole full video unlock hoyni. Fresh logged-in cookies.txt export kore retry korun."
        )

    all_urls = media_urls_from_text(webpage) + media_urls_from_state(state)
    media_url = best_media_url(all_urls, require_full=require_premium or is_premium)
    if (require_premium or is_premium) and not media_url:
        raise PremiumAccessError(
            "Faphouse page-e sudhu trailer/preview source paowa geche — full video source unlock hoyni. Fresh premium cookies.txt save kore retry korun."
        )
    if media_url:
        logger.info("Faphouse media chosen: %s (from %d candidates)", media_url, len(all_urls))
    return ResolvedMedia(media_url, page_title) if media_url else None


def check_cookie_access(url: str, cookies_text: Optional[str]) -> CookieCheckOut:
    page_url = normalize_download_url(url)
    stats = cookie_row_stats(cookies_text or "", page_url)
    if not cookies_text:
        return CookieCheckOut(
            ok=False,
            status="missing",
            message="Ei URL-er jonno kono cookies attach hoyni — domain match koreni ba Cookie vault-e save nei.",
        )
    if stats["matched"] == 0:
        return CookieCheckOut(
            ok=False,
            status="domain_mismatch",
            message="Cookies ache, kintu ei URL-er domain-er sathe kono cookie row match koreni.",
            matched_cookie_rows=0,
            active_cookie_rows=0,
            expired_cookie_rows=stats["expired"],
        )
    if stats["active"] == 0:
        return CookieCheckOut(
            ok=False,
            status="expired",
            message="Matching cookie rows shob expired — site-e abar login kore fresh cookies.txt export korun.",
            matched_cookie_rows=stats["matched"],
            active_cookie_rows=stats["active"],
            expired_cookie_rows=stats["expired"],
        )

    with tempfile.TemporaryDirectory(prefix="ck_") as tmp:
        cookies_path = Path(tmp) / "cookies.txt"
        cookies_path.write_text(expand_cookie_domains(cookies_text), encoding="utf-8")
        try:
            webpage = request_with_cookiefile(page_url, cookies_path, referer=page_url)
        except urllib.error.HTTPError as e:
            if e.code in {401, 403}:
                return CookieCheckOut(
                    ok=False,
                    status="rejected",
                    message="Site cookies reject koreche — expired, logged-out, ba wrong account hote pare.",
                    matched_cookie_rows=stats["matched"],
                    active_cookie_rows=stats["active"],
                    expired_cookie_rows=stats["expired"],
                )
            raise

    state = parse_view_state(webpage)
    video = state.get("video") if isinstance(state.get("video"), dict) else {}
    is_premium = video.get("videoAccessType") == "premium"
    is_allowed = bool(video.get("videoViewAllowed")) if video else None
    login_detected = any(
        token in webpage.lower()
        for token in ("logout", "sign out", "my profile", "subscription", "account-menu")
    )

    if is_premium and is_allowed is False:
        return CookieCheckOut(
            ok=False,
            status="no_premium_access",
            message="Cookies active/matched, kintu ei premium video account-e unlock allowed na — wrong account, expired login, ba premium subscription nei.",
            matched_cookie_rows=stats["matched"],
            active_cookie_rows=stats["active"],
            expired_cookie_rows=stats["expired"],
            premium=True,
            allowed=False,
            login_detected=login_detected,
        )

    return CookieCheckOut(
        ok=True,
        status="ok",
        message="Cookies domain-e match koreche ebong site page access test pass koreche.",
        matched_cookie_rows=stats["matched"],
        active_cookie_rows=stats["active"],
        expired_cookie_rows=stats["expired"],
        premium=is_premium if video else None,
        allowed=is_allowed,
        login_detected=login_detected,
    )


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
        "outtmpl": str(out_dir / "%(title).200B.%(ext)s"),
        "format": fmt,
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "restrictfilenames": False,
        "windowsfilenames": False,
        "trim_file_name": 200,
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


def _serialize_cookiejar(jar: http.cookiejar.CookieJar) -> Optional[str]:
    """Serialize a cookie jar to Netscape format if it contains login-looking cookies."""
    lines = ["# Netscape HTTP Cookie File", ""]
    has_auth_cookie = False
    for c in jar:
        domain = c.domain if c.domain.startswith(".") else "." + c.domain
        include_subs = "TRUE"
        path = c.path or "/"
        secure = "TRUE" if c.secure else "FALSE"
        expires = int(c.expires) if c.expires else SESSION_COOKIE_EXPIRES
        name = c.name
        value = c.value or ""
        if any(tok in name.lower() for tok in ("token", "session", "auth", "sid", "jwt", "user", "login")):
            has_auth_cookie = True
        lines.append(f"{domain}\t{include_subs}\t{path}\t{secure}\t{expires}\t{name}\t{value}")

    if not has_auth_cookie:
        return None
    return "\n".join(lines) + "\n"


def faphouse_login_cookies(email: str, password: str) -> Optional[str]:
    """Log in to Faphouse with email/password and return a Netscape cookie file.

    Result is cached in-process for _FAPHOUSE_LOGIN_TTL seconds. Returns None
    if login fails. Tries known login endpoints; Faphouse's exact API may
    change — errors are logged so we can iterate.
    """
    cached = _FAPHOUSE_LOGIN_CACHE.get(email)
    now = time.time()
    if cached and cached[1] > now:
        return cached[0]

    ua = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/128.0.0.0 Safari/537.36"
    )
    endpoint_paths = [
        "/api/auth/signin",  # current SPA endpoint from site-spa-initial-data
        "/api/auth/sign-in",
        "/api/auth/login",
        "/api/v1/auth/sign-in",
        "/api/user/login",
    ]
    origins = ["https://faphouse.com", "https://faphouse2.com"]
    payloads = [
        {"login": email, "password": password},
        {"email": email, "password": password},
        {"username": email, "password": password},
    ]

    last_err: Optional[str] = None
    cookie_text: Optional[str] = None

    for origin in origins:
        jar = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        opener.addheaders = [
            ("User-Agent", ua),
            ("Accept-Language", "en-US,en;q=0.9"),
        ]

        # Prime cookies (visitor/CSRF/session) by visiting the same origin first.
        try:
            opener.open(urllib.request.Request(f"{origin}/", headers={"User-Agent": ua}), timeout=30).read()
        except Exception as e:
            logger.warning("Faphouse homepage prime failed for %s: %s", origin, e)

        for path in endpoint_paths:
            endpoint = f"{origin}{path}"
            for payload_dict in payloads:
                attempts = [
                    (
                        json.dumps(payload_dict).encode("utf-8"),
                        "application/json",
                    ),
                    (
                        urllib.parse.urlencode(payload_dict).encode("utf-8"),
                        "application/x-www-form-urlencoded; charset=UTF-8",
                    ),
                ]
                for payload, content_type in attempts:
                    headers = {
                        "User-Agent": ua,
                        "Content-Type": content_type,
                        "Accept": "application/json, text/plain, */*",
                        "Accept-Language": "en-US,en;q=0.9",
                        "Origin": origin,
                        "Referer": f"{origin}/#signin",
                        "X-Requested-With": "XMLHttpRequest",
                    }
                    try:
                        req = urllib.request.Request(endpoint, data=payload, headers=headers, method="POST")
                        with opener.open(req, timeout=30) as resp:
                            status = resp.status
                            body_snippet = resp.read(500).decode("utf-8", "ignore")
                        serialized = _serialize_cookiejar(jar)
                        if 200 <= status < 300 and serialized:
                            logger.info("Faphouse login OK via %s (%s, status=%s)", endpoint, content_type, status)
                            cookie_text = serialized
                            break
                        last_err = f"{endpoint} {content_type} -> {status}: {body_snippet[:200]}"
                    except urllib.error.HTTPError as e:
                        body_snippet = ""
                        try:
                            body_snippet = e.read(500).decode("utf-8", "ignore")
                        except Exception:
                            pass
                        last_err = f"{endpoint} {content_type} -> {e.code}: {body_snippet[:200]}"
                    except Exception as e:
                        last_err = f"{endpoint} {content_type} -> {e}"
                if cookie_text:
                    break
            if cookie_text:
                break
        if cookie_text:
            break

    if not cookie_text:
        logger.warning("Faphouse auto-login failed on all endpoint/payload variants. Last error: %s", last_err)
        return None

    _FAPHOUSE_LOGIN_CACHE[email] = (cookie_text, now + _FAPHOUSE_LOGIN_TTL)
    return cookie_text





def download_url(
    url: str,
    out_dir: Path,
    mode: str,
    quality: str,
    request_cookies: Optional[str] = None,
) -> Path:
    # Per-request cookies (from the web app) take priority over the
    # server-wide YT_DLP_COOKIES env fallback. If neither is present
    # and this is a Faphouse URL, try auto-login with FAPHOUSE_EMAIL/PASSWORD.
    cookies_path = None
    cookies_text: Optional[str] = None
    is_faphouse = is_faphouse_url(url)
    if is_faphouse and FAPHOUSE_EMAIL and FAPHOUSE_PASSWORD:
        try:
            cookies_text = faphouse_login_cookies(FAPHOUSE_EMAIL, FAPHOUSE_PASSWORD)
            if cookies_text:
                logger.info("Using Faphouse auto-login cookies before saved cookie fallback for %s", url)
        except Exception as e:
            logger.warning("Faphouse auto-login failed: %s", e)
    if not cookies_text:
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
        if is_faphouse_url(attempt_url):
            try:
                media = resolve_faphouse_media_url(
                    attempt_url,
                    cookies_path,
                    require_premium=cookies_path is not None,
                )
                if media:
                    media_opts = {**base_opts}
                    if media.title:
                        media_opts["outtmpl"] = str(out_dir / f"{media.title}.%(ext)s")
                    media_opts["http_headers"] = {
                        **base_opts.get("http_headers", {}),
                        "Referer": attempt_url,
                        "Origin": faphouse_origin(attempt_url),
                    }
                    result = _run(media.url, media_opts)
                    if result:
                        return result
            except PremiumAccessError as e:
                last_error = e
                raise
            except Exception as e:
                last_error = e
                logger.info("Faphouse direct media resolver failed for %s: %s", attempt_url, e)
                if cookies_path is not None:
                    raise

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

        # Cloudflare anti-bot: retry with curl_cffi browser impersonation.
        err_text = str(last_error).lower() if last_error else ""
        if any(s in err_text for s in ("cloudflare", "http error 403", "http error 429", "http error 503")):
            try:
                from yt_dlp.networking.impersonate import ImpersonateTarget
            except Exception:
                ImpersonateTarget = None  # type: ignore
            if ImpersonateTarget is not None:
                for target_str in ("chrome", "chrome-110", "safari"):
                    try:
                        target_obj = ImpersonateTarget.from_str(target_str)
                    except Exception:
                        continue
                    logger.info("Retrying %s with impersonate=%s (Cloudflare bypass)", attempt_url, target_str)
                    impersonate_opts = {
                        **base_opts,
                        "force_generic_extractor": True,
                        "impersonate": target_obj,
                    }
                    try:
                        result = _run(attempt_url, impersonate_opts)
                        if result:
                            return result
                    except Exception as e:
                        last_error = e
                        logger.info("Impersonate (%s) failed for %s: %s", target_str, attempt_url, e)

    if last_error:
        raise last_error
    raise RuntimeError("Download finished but no file found")


def run_download_to_drive(body: DownloadIn) -> DownloadOut:
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
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def download_job_id(body: DownloadIn) -> str:
    seed = body.client_job_id or f"{time.time_ns()}"
    digest = hashlib.sha1(
        json.dumps(
            {
                "seed": seed,
                "url": body.url,
                "mode": body.mode,
                "quality": body.quality,
                "cookies": body.cookies or "",
            },
            sort_keys=True,
        ).encode("utf-8")
    ).hexdigest()[:16]
    safe_seed = re.sub(r"[^a-zA-Z0-9_-]+", "", seed)[:48] or "job"
    return f"{safe_seed}-{digest}"


def cleanup_download_jobs() -> None:
    cutoff = time.time() - _DOWNLOAD_JOB_TTL
    with _DOWNLOAD_JOBS_LOCK:
        stale = [job_id for job_id, job in _DOWNLOAD_JOBS.items() if job.get("updated_at", 0) < cutoff]
        for job_id in stale:
            _DOWNLOAD_JOBS.pop(job_id, None)


def run_download_job(job_id: str, body: DownloadIn) -> None:
    with _DOWNLOAD_JOBS_LOCK:
        _DOWNLOAD_JOBS[job_id].update({"status": "running", "updated_at": time.time()})
    try:
        result = run_download_to_drive(body)
        with _DOWNLOAD_JOBS_LOCK:
            _DOWNLOAD_JOBS[job_id].update(
                {"status": "done", "result": result, "error": None, "updated_at": time.time()}
            )
    except Exception as e:
        logger.exception("download job failed: %s", job_id)
        detail = str(e).strip() or e.__class__.__name__
        with _DOWNLOAD_JOBS_LOCK:
            _DOWNLOAD_JOBS[job_id].update(
                {"status": "error", "result": None, "error": detail[:400], "updated_at": time.time()}
            )




# ---------- Routes ----------

@app.get("/")
def health():
    return {"ok": True, "service": "drivegrabber-api"}


@app.post("/cookies/check", response_model=CookieCheckOut)
def check_cookies(body: CookieCheckIn, x_api_token: str = Header(None)):
    if not x_api_token or x_api_token != API_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized")
    try:
        return check_cookie_access(body.url, body.cookies)
    except Exception as e:
        logger.exception("cookie check failed")
        detail = str(e).strip() or e.__class__.__name__
        raise HTTPException(status_code=500, detail=detail[:400])


@app.post("/download", response_model=DownloadOut)
def download(body: DownloadIn, x_api_token: str = Header(None)):
    if not x_api_token or x_api_token != API_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized")

    try:
        return run_download_to_drive(body)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("download failed")
        detail = str(e).strip() or e.__class__.__name__
        raise HTTPException(status_code=500, detail=detail[:400])


@app.post("/download/start", response_model=DownloadStartOut)
def start_download(body: DownloadIn, x_api_token: str = Header(None)):
    if not x_api_token or x_api_token != API_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized")

    cleanup_download_jobs()
    job_id = download_job_id(body)
    with _DOWNLOAD_JOBS_LOCK:
        existing = _DOWNLOAD_JOBS.get(job_id)
        if existing:
            return DownloadStartOut(ok=True, job_id=job_id, status=existing["status"])
        _DOWNLOAD_JOBS[job_id] = {
            "status": "queued",
            "result": None,
            "error": None,
            "created_at": time.time(),
            "updated_at": time.time(),
        }

    thread = threading.Thread(target=run_download_job, args=(job_id, body), daemon=True)
    thread.start()
    return DownloadStartOut(ok=True, job_id=job_id, status="queued")


@app.get("/download/status/{job_id}", response_model=DownloadStatusOut)
def download_status(job_id: str, x_api_token: str = Header(None)):
    if not x_api_token or x_api_token != API_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized")

    cleanup_download_jobs()
    with _DOWNLOAD_JOBS_LOCK:
        job = _DOWNLOAD_JOBS.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found or expired")
        return DownloadStatusOut(
            ok=True,
            job_id=job_id,
            status=job["status"],
            result=job.get("result"),
            error=job.get("error"),
        )
