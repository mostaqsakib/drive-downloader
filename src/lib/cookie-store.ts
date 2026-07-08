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

export type CookieSummary = {
  totalRows: number;
  activeRows: number;
  expiredRows: number;
  sessionRows: number;
  domains: string[];
  earliestExpiry?: number;
};

export function loadCookies(): CookieEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as CookieEntry[];
    if (!Array.isArray(parsed)) return [];
    const byDomain = new Map<string, CookieEntry>();
    for (const entry of parsed) {
      if (!entry || typeof entry.cookies !== "string") continue;
      const domain = canonicalHost(String(entry.domain ?? ""));
      if (!domain) continue;
      const normalized = { ...entry, domain };
      const existing = byDomain.get(domain);
      if (!existing || normalized.updatedAt > existing.updatedAt) byDomain.set(domain, normalized);
    }
    return [...byDomain.values()].sort((a, b) => a.domain.localeCompare(b.domain));
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
  const raw = host.trim();
  let parsed = raw;
  try {
    parsed = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname;
  } catch {
    parsed = raw.split("/")[0] ?? raw;
  }
  return parsed.replace(/^\.+/, "").replace(/^www\./i, "").toLowerCase();
}

// Collapse mirror suffixes like "faphouse2.com" → "faphouse.com" so cookies
// saved for the main domain also match numbered mirrors, and vice versa.
function mirrorAliases(host: string): string[] {
  const aliases = new Set<string>([host]);
  const stripped = host.replace(/^([a-z]+?)\d+(\.[a-z.]+)$/i, "$1$2");
  if (stripped !== host) aliases.add(stripped);
  if (stripped === "faphouse.com") {
    aliases.add("faphouse.com");
    aliases.add("faphouse2.com");
  }
  return [...aliases];
}

function cookieTextDomains(cookies: string): string[] {
  const domains = new Set<string>();
  for (const rawLine of cookies.split(/\r?\n/)) {
    const line = rawLine.replace(/^#HttpOnly_/, "");
    if (!line || line.startsWith("#")) continue;
    const tabDomain = line.includes("\t") ? (line.split("\t")[0] ?? "") : "";
    const setCookieDomain = /(?:^|;)\s*domain=([^;\s]+)/i.exec(line)?.[1] ?? "";
    const domain = canonicalHost(tabDomain || setCookieDomain);
    if (domain && domain.includes(".")) {
      for (const alias of mirrorAliases(domain)) domains.add(alias);
    }
  }
  return [...domains];
}

export function summarizeCookies(cookies: string): CookieSummary {
  const now = Math.floor(Date.now() / 1000);
  const domains = new Set<string>();
  let totalRows = 0;
  let activeRows = 0;
  let expiredRows = 0;
  let sessionRows = 0;
  let earliestExpiry: number | undefined;

  for (const rawLine of cookies.split(/\r?\n/)) {
    const line = rawLine.replace(/^#HttpOnly_/, "");
    if (!line || line.startsWith("#") || !line.includes("\t")) continue;
    const parts = line.split("\t");
    if (parts.length < 7) continue;
    totalRows += 1;
    const domain = canonicalHost(parts[0] ?? "");
    if (domain) domains.add(domain);
    const expiry = Number(parts[4] ?? 0);
    if (!Number.isFinite(expiry) || expiry <= 0) {
      sessionRows += 1;
      activeRows += 1;
    } else if (expiry < now) {
      expiredRows += 1;
    } else {
      activeRows += 1;
      earliestExpiry = earliestExpiry ? Math.min(earliestExpiry, expiry) : expiry;
    }
  }

  return {
    totalRows,
    activeRows,
    expiredRows,
    sessionRows,
    domains: [...domains].sort(),
    earliestExpiry,
  };
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
      const aliases = [
        ...mirrorAliases(canonicalHost(e.domain)),
        ...cookieTextDomains(e.cookies),
      ];
      return hosts.some((h) =>
        aliases.some((d) => h === d || h.endsWith("." + d) || d.endsWith("." + h)),
      );
    })
    .sort((a, b) => b.domain.length - a.domain.length)[0];
  return match ?? null;
}
