// Client-side cookie vault for premium sites (yt-dlp Netscape format).
// Cookies live in localStorage — they never touch the server unless a
// matching URL is submitted, in which case they're forwarded to the
// Railway API to hand off to yt-dlp.

const KEY = "drivegrabber.cookies.v1";

export type CookieEntry = {
  domain: string; // canonical host suffix, e.g. "youtube.com"
  label?: string;
  cookies: string; // raw Netscape cookies.txt content
  updatedAt: number;
};

export function loadCookies(): CookieEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as CookieEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveCookies(entries: CookieEntry[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, JSON.stringify(entries));
}

// Strip "www." and any leading dot so "www.youtube.com" and ".youtube.com"
// both match the "youtube.com" bucket.
export function canonicalHost(host: string): string {
  return host.replace(/^\.+/, "").replace(/^www\./i, "").toLowerCase();
}

export function hostFromUrl(url: string): string | null {
  try {
    return canonicalHost(new URL(url).hostname);
  } catch {
    return null;
  }
}

// Return the stored cookies whose stored domain is a suffix of the URL's
// host — so "youtube.com" bucket matches "m.youtube.com" and "music.youtube.com".
export function pickCookiesFor(url: string): CookieEntry | null {
  const host = hostFromUrl(url);
  if (!host) return null;
  const entries = loadCookies();
  const match = entries
    .filter((e) => host === e.domain || host.endsWith("." + e.domain))
    .sort((a, b) => b.domain.length - a.domain.length)[0];
  return match ?? null;
}
