import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const inputSchema = z.object({
  url: z.string().trim().url({ message: "Valid URL diben" }).max(2048),
  mode: z.enum(["auto", "audio", "mute"]).default("auto"),
  quality: z.enum(["max", "1080", "720", "480", "360"]).default("1080"),
});

export type CobaltResult =
  | { kind: "redirect" | "tunnel"; url: string; filename?: string; instance?: string }
  | { kind: "picker"; items: { url: string; thumb?: string; type?: string }[]; instance?: string }
  | { kind: "error"; message: string };

// Fallback chain of public Cobalt instances (no auth required).
// User can override the primary via COBALT_API_URL secret.
const FALLBACK_INSTANCES = [
  "https://dwnld.nichind.dev",
  "https://co.eepy.today",
];

function cleanUrl(input: string): string {
  try {
    const u = new URL(input);
    // Strip YouTube playlist/mix params that trigger login requirements
    if (/(^|\.)youtube\.com$/.test(u.hostname) || u.hostname === "youtu.be") {
      ["list", "start_radio", "index", "pp", "si"].forEach((p) => u.searchParams.delete(p));
    }
    return u.toString();
  } catch {
    return input;
  }
}

type CobaltJson = {
  status?: string;
  url?: string;
  filename?: string;
  tunnel?: string[];
  type?: string;
  picker?: { url: string; thumb?: string; type?: string }[];
  error?: { code?: string; message?: string };
  text?: string;
};

async function callInstance(
  base: string,
  body: Record<string, unknown>,
  apiKey?: string,
): Promise<{ ok: true; json: CobaltJson } | { ok: false; error: string; retryable: boolean }> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": "DriveGrabber/1.0",
  };
  if (apiKey) headers["Authorization"] = `Api-Key ${apiKey}`;

  let res: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    res = await fetch(base.replace(/\/+$/, "") + "/", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (e) {
    return { ok: false, error: `network: ${(e as Error).message}`, retryable: true };
  }

  let json: CobaltJson;
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: `HTTP ${res.status} invalid JSON`, retryable: true };
  }

  if (json.status === "error") {
    const code = json.error?.code || "";
    // Instance-level failures worth retrying on another instance
    const retryable =
      code.includes("auth") ||
      code.includes("rate") ||
      code.includes("youtube.login") ||
      code.includes("youtube.decipher") ||
      code.includes("fetch") ||
      code.includes("content.video.unavailable");
    return { ok: false, error: code || json.error?.message || json.text || "unknown", retryable };
  }
  return { ok: true, json };
}

export const fetchDownload = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => inputSchema.parse(data))
  .handler(async ({ data }): Promise<CobaltResult> => {
    const userInstance = process.env.COBALT_API_URL?.replace(/\/+$/, "");
    const apiKey = process.env.COBALT_API_KEY;
    const instances = userInstance
      ? [userInstance, ...FALLBACK_INSTANCES.filter((i) => i !== userInstance)]
      : FALLBACK_INSTANCES;

    const cleanedUrl = cleanUrl(data.url);
    const body = {
      url: cleanedUrl,
      videoQuality: data.quality,
      downloadMode: data.mode,
      audioFormat: "mp3",
      filenameStyle: "pretty",
      youtubeVideoContainer: "mp4",
    };

    let lastError = "All download instances failed";

    for (const base of instances) {
      const result = await callInstance(base, body, apiKey);
      if (!result.ok) {
        lastError = `${new URL(base).hostname}: ${result.error}`;
        if (!result.retryable) break;
        continue;
      }

      const { json } = result;
      const host = new URL(base).hostname;
      switch (json.status) {
        case "tunnel":
        case "redirect":
          return {
            kind: json.status,
            url: json.url!,
            filename: json.filename,
            instance: host,
          };
        case "local-processing": {
          const tunnels = json.tunnel ?? [];
          if (tunnels.length === 0) {
            lastError = `${host}: empty tunnel`;
            continue;
          }
          if (tunnels.length === 1) {
            return { kind: "tunnel", url: tunnels[0], filename: json.filename, instance: host };
          }
          return {
            kind: "picker",
            instance: host,
            items: tunnels.map((u, i) => ({ url: u, type: i === 0 ? "video" : "audio" })),
          };
        }
        case "picker":
          return { kind: "picker", items: json.picker ?? [], instance: host };
        default:
          lastError = `${host}: unexpected status ${json.status ?? "none"}`;
      }
    }

    // Give the user a friendly message
    let friendly = lastError;
    if (/link\.invalid|link\.unsupported|unsupported/i.test(lastError)) {
      friendly =
        "Ei site/URL Cobalt support kore na. Supported: YouTube, TikTok, Instagram, Twitter/X, Reddit, Vimeo, Facebook, SoundCloud, Twitch, Bluesky, Tumblr, Pinterest, Dailymotion, Loom, Rutube, VK, Bilibili, Snapchat. Adult sites (xxxbp, pornhub, xvideos ityadi) support nei.";
    } else if (/youtube\.login/i.test(lastError)) {
      friendly =
        "YouTube ei muhurte ei public instance gulor IP block korche (bot protection). Kichukhon por abar try koren, ba onno video/site try koren.";
    } else if (/auth/i.test(lastError)) {
      friendly = "Sob public instance ekhon authentication chachhe. Kichukhon por retry koren.";
    }
    return { kind: "error", message: friendly };
  });

