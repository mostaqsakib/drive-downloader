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

const SESSION_EXPIRY_FALLBACK = 4_102_444_799; // 2099-12-31 for browser session cookies

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

function isFaphouseHost(host: string): boolean {
  return mirrorAliases(host).includes("faphouse.com");
}

function collectJsonCookieDomains(cookies: string): string[] {
  try {
    const parsed = JSON.parse(cookies) as unknown;
    const rows = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { cookies?: unknown }).cookies)
        ? (parsed as { cookies: unknown[] }).cookies
        : [];
    return rows
      .map((row) => {
        if (!row || typeof row !== "object") return "";
        const value = (row as { domain?: unknown; host?: unknown }).domain ?? (row as { domain?: unknown; host?: unknown }).host;
        return typeof value === "string" ? canonicalHost(value) : "";
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function cookieTextDomains(cookies: string): string[] {
  const domains = new Set<string>();
  for (const domain of collectJsonCookieDomains(cookies)) {
    for (const alias of mirrorAliases(domain)) domains.add(alias);
  }
  for (const rawLine of cookies.split(/\r?\n/)) {
    const line = rawLine.replace(/^#HttpOnly_/, "");
    if (!line || line.startsWith("#")) continue;
    const tabDomain = line.includes("\t") ? (line.split("\t")[0] ?? "") : "";
    const spaceDomain = !tabDomain && /^\.?[a-z0-9.-]+\s+(?:TRUE|FALSE)\s+\//i.test(line)
      ? (line.split(/\s+/)[0] ?? "")
      : "";
    const setCookieDomain = /(?:^|;)\s*domain=([^;\s]+)/i.exec(line)?.[1] ?? "";
    const domain = canonicalHost(tabDomain || spaceDomain || setCookieDomain);
    if (domain && domain.includes(".")) {
      for (const alias of mirrorAliases(domain)) domains.add(alias);
    }
  }
  return [...domains];
}

function cookieTextLooksRelevant(cookies: string, host: string): boolean {
  const lower = cookies.toLowerCase();
  const aliases = mirrorAliases(host);
  if (aliases.some((alias) => lower.includes(alias))) return true;
  return isFaphouseHost(host) && /faphouse|fh_session|remember|session|auth|token/i.test(cookies);
}

export function summarizeCookies(cookies: string): CookieSummary {
  const now = Math.floor(Date.now() / 1000);
  const domains = new Set<string>();
  for (const domain of collectJsonCookieDomains(cookies)) domains.add(domain);
  let totalRows = 0;
  let activeRows = 0;
  let expiredRows = 0;
  let sessionRows = 0;
  let earliestExpiry: number | undefined;

  for (const rawLine of cookies.split(/\r?\n/)) {
    const line = rawLine.replace(/^#HttpOnly_/, "");
    if (!line || line.startsWith("#")) continue;
    const parts = line.includes("\t") ? line.split("\t") : line.split(/\s+/);
    if (parts.length < 7) continue;
    totalRows += 1;
    const domain = canonicalHost(parts[0] ?? "");
    if (domain) domains.add(domain);
    const expiry = Number(parts[4] ?? 0);
    if (!Number.isFinite(expiry) || expiry <= 0 || expiry >= SESSION_EXPIRY_FALLBACK) {
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
  const scored = entries
    .map((e) => {
      const aliases = [
        ...mirrorAliases(canonicalHost(e.domain)),
        ...cookieTextDomains(e.cookies),
      ];
      const directMatch = hosts.some((h) =>
        aliases.some((d) => h === d || h.endsWith("." + d) || d.endsWith("." + h)),
      );
      const textMatch = cookieTextLooksRelevant(e.cookies, host);
      const faphouseFallback = isFaphouseHost(host) && entries.length === 1;
      if (!directMatch && !textMatch && !faphouseFallback) return null;
      const summary = summarizeCookies(e.cookies);
      const score =
        (directMatch ? 100 : 0) +
        (textMatch ? 25 : 0) +
        (faphouseFallback ? 10 : 0) +
        Math.min(summary.activeRows, 20);
      return { entry: e, score };
    })
    .filter((item): item is { entry: CookieEntry; score: number } => item !== null)
    .sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt || b.entry.domain.length - a.entry.domain.length);
  return scored[0]?.entry ?? null;
}
