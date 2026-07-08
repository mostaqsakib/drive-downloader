import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const inputSchema = z.object({
  url: z.string().trim().url({ message: "Valid URL diben" }).max(2048),
  mode: z.enum(["auto", "audio", "mute"]).default("auto"),
  quality: z.enum(["max", "1080", "720", "480", "360"]).default("1080"),
  cookies: z.string().max(200_000).optional(),
});


export type DriveResult =
  | {
      kind: "success";
      name: string;
      sizeMb: number;
      downloadSeconds: number;
      uploadSeconds: number;
      viewLink: string | null;
      fileId: string;
    }
  | { kind: "error"; message: string };

export const saveToDrive = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => inputSchema.parse(data))
  .handler(async ({ data }): Promise<DriveResult> => {
    const base = process.env.RAILWAY_API_URL?.replace(/\/+$/, "");
    const token = process.env.API_SECRET_TOKEN;
    if (!base || !token) {
      return {
        kind: "error",
        message:
          "Server-e RAILWAY_API_URL ba API_SECRET_TOKEN set nei. Railway API deploy kore secrets add koren.",
      };
    }

    const controller = new AbortController();
    // Big files can take a while — allow up to 9 minutes.
    const timer = setTimeout(() => controller.abort(), 9 * 60 * 1000);

    try {
      const res = await fetch(`${base}/download`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Token": token,
        },
        body: JSON.stringify(data),
        signal: controller.signal,
      });

      const bodyText = await res.text();
      let payload: unknown;
      try {
        payload = bodyText ? JSON.parse(bodyText) : null;
      } catch {
        const fallback = bodyText.trim() || res.statusText || "No error details returned";
        return { kind: "error", message: `API ${res.status}: ${fallback.slice(0, 200)}` };
      }

      if (!res.ok) {
        const detailValue = (payload as { detail?: unknown } | null)?.detail;
        const detail =
          typeof detailValue === "string"
            ? detailValue.trim()
            : detailValue
              ? JSON.stringify(detailValue)
              : bodyText.trim() || res.statusText || `HTTP ${res.status}`;
        return { kind: "error", message: `Railway API: ${detail || `HTTP ${res.status}`}` };
      }

      const p = payload as {
        name: string;
        size_mb: number;
        download_seconds: number;
        upload_seconds: number;
        view_link: string | null;
        file_id: string;
      };
      return {
        kind: "success",
        name: p.name,
        sizeMb: p.size_mb,
        downloadSeconds: p.download_seconds,
        uploadSeconds: p.upload_seconds,
        viewLink: p.view_link,
        fileId: p.file_id,
      };
    } catch (e) {
      const msg =
        (e as Error).name === "AbortError"
          ? "Timeout — file khub boro ba API slow. Abar try koren."
          : `Network: ${(e as Error).message}`;
      return { kind: "error", message: msg };
    } finally {
      clearTimeout(timer);
    }
  });
