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

// Collapse mirror suffixes like "faphouse2.com" → "faphouse.com" so cookies
// saved for the main domain also match numbered mirrors, and vice versa.
function mirrorAliases(host: string): string[] {
  const aliases = new Set<string>([host]);
  const stripped = host.replace(/^([a-z]+?)\d+(\.[a-z.]+)$/i, "$1$2");
  if (stripped !== host) aliases.add(stripped);
  return [...aliases];
}

export function hostFromUrl(url: string): string | null {
  try {
    return canonicalHost(new URL(url).hostname);
  } catch {
    return null;
  }
}

// Return the stored cookies whose stored domain is a suffix of the URL's
// host. Also matches numbered mirrors ("faphouse2.com" ↔ "faphouse.com").
export function pickCookiesFor(url: string): CookieEntry | null {
  const host = hostFromUrl(url);
  if (!host) return null;
  const hosts = mirrorAliases(host);
  const entries = loadCookies();
  const match = entries
    .filter((e) => {
      const aliases = mirrorAliases(e.domain);
      return hosts.some((h) =>
        aliases.some((d) => h === d || h.endsWith("." + d) || d.endsWith("." + h)),
      );
    })
    .sort((a, b) => b.domain.length - a.domain.length)[0];
  return match ?? null;
}
