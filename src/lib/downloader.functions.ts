import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const inputSchema = z.object({
  url: z.string().trim().url({ message: "Valid URL diben" }).max(2048),
  mode: z.enum(["auto", "audio", "mute"]).default("auto"),
  quality: z.enum(["max", "1080", "720", "480", "360"]).default("1080"),
});

export type CobaltResult =
  | { kind: "redirect" | "tunnel"; url: string; filename?: string }
  | { kind: "picker"; items: { url: string; thumb?: string; type?: string }[] }
  | { kind: "error"; message: string };

export const fetchDownload = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => inputSchema.parse(data))
  .handler(async ({ data }): Promise<CobaltResult> => {
    const apiBase = process.env.COBALT_API_URL?.replace(/\/+$/, "") || "https://co.eepy.today";
    const apiKey = process.env.COBALT_API_KEY;

    const headers: Record<string, string> = {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "User-Agent": "DriveGrabber/1.0",
    };
    if (apiKey) headers["Authorization"] = `Api-Key ${apiKey}`;

    let res: Response;
    try {
      res = await fetch(apiBase + "/", {
        method: "POST",
        headers,
        body: JSON.stringify({
          url: data.url,
          videoQuality: data.quality,
          downloadMode: data.mode,
          audioFormat: "mp3",
          filenameStyle: "pretty",
          youtubeVideoContainer: "mp4",
        }),
      });
    } catch (e) {
      return { kind: "error", message: `Cobalt e connect korte parlam na: ${(e as Error).message}` };
    }

    let json: {
      status?: string;
      url?: string;
      filename?: string;
      tunnel?: string[];
      type?: string;
      picker?: { url: string; thumb?: string; type?: string }[];
      error?: { code?: string; message?: string };
      text?: string;
    };
    try {
      json = await res.json();
    } catch {
      return { kind: "error", message: `Cobalt theke invalid response (HTTP ${res.status})` };
    }

    switch (json.status) {
      case "tunnel":
      case "redirect":
        return { kind: json.status, url: json.url!, filename: json.filename };
      case "local-processing": {
        const tunnels = json.tunnel ?? [];
        if (tunnels.length === 0) return { kind: "error", message: "No download URL returned" };
        if (tunnels.length === 1) return { kind: "tunnel", url: tunnels[0], filename: json.filename };
        // Multiple streams (e.g. video + audio need merging) — show both as picker
        return {
          kind: "picker",
          items: tunnels.map((u, i) => ({
            url: u,
            type: i === 0 ? "video" : "audio",
          })),
        };
      }
      case "picker":
        return { kind: "picker", items: json.picker ?? [] };
      case "error":
      default: {
        const code = json.error?.code || "";
        let msg = json.error?.message || json.text || code || "Download failed";
        if (code.includes("auth")) {
          msg = "Cobalt instance authentication chachhe. Different instance try koren ba COBALT_API_URL secret set koren.";
        }
        return { kind: "error", message: msg };
      }
    }
  });

