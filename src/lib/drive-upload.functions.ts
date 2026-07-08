import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const inputSchema = z.object({
  url: z.string().trim().url({ message: "Valid URL diben" }).max(2048),
  mode: z.enum(["auto", "audio", "mute"]).default("auto"),
  quality: z.enum(["max", "1080", "720", "480", "360"]).default("max"),
  cookies: z.string().max(1_000_000).optional(),
  clientJobId: z.string().max(120).optional(),
});

const jobStatusSchema = z.object({
  jobId: z.string().min(1).max(160),
});

const cookieCheckSchema = z.object({
  url: z.string().trim().url({ message: "Valid URL diben" }).max(2048),
  cookies: z.string().max(1_000_000).optional(),
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

export type DriveStartResult =
  | { kind: "success"; jobId: string; status: string }
  | { kind: "error"; message: string };

export type DriveJobProgress = {
  phase?: string | null;
  downloadProgress?: number | null;
  uploadProgress?: number | null;
  downloadedBytes?: number | null;
  totalBytes?: number | null;
  uploadedBytes?: number | null;
  uploadTotalBytes?: number | null;
};

export type DriveJobStatusResult =
  | ({
      kind: "success";
      jobId: string;
      status: "queued" | "running" | "done" | "error";
      result?: Exclude<DriveResult, { kind: "error" }>;
      error?: string;
    } & DriveJobProgress)
  | { kind: "error"; message: string };

export type CookieCheckResult =
  | {
      kind: "success";
      ok: boolean;
      status: string;
      message: string;
      matchedRows: number;
      activeRows: number;
      expiredRows: number;
      premium?: boolean | null;
      allowed?: boolean | null;
      loginDetected?: boolean | null;
    }
  | { kind: "error"; message: string };

export const checkCookieAccess = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => cookieCheckSchema.parse(data))
  .handler(async ({ data }): Promise<CookieCheckResult> => {
    const base = process.env.RAILWAY_API_URL?.replace(/\/+$/, "");
    const token = process.env.API_SECRET_TOKEN;
    if (!base || !token) {
      return {
        kind: "error",
        message: "Server-e RAILWAY_API_URL ba API_SECRET_TOKEN set nei.",
      };
    }

    try {
      const res = await fetch(`${base}/cookies/check`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Token": token,
        },
        body: JSON.stringify(data),
      });
      const bodyText = await res.text();
      let payload: unknown;
      try {
        payload = bodyText ? JSON.parse(bodyText) : null;
      } catch {
        return { kind: "error", message: `API ${res.status}: ${bodyText.slice(0, 200)}` };
      }
      if (!res.ok) {
        const detailValue = (payload as { detail?: unknown } | null)?.detail;
        const detail = typeof detailValue === "string" ? detailValue : JSON.stringify(detailValue);
        return { kind: "error", message: `Railway API: ${detail || `HTTP ${res.status}`}` };
      }
      const p = payload as {
        ok: boolean;
        status: string;
        message: string;
        matched_cookie_rows: number;
        active_cookie_rows: number;
        expired_cookie_rows: number;
        premium?: boolean | null;
        allowed?: boolean | null;
        login_detected?: boolean | null;
      };
      return {
        kind: "success",
        ok: p.ok,
        status: p.status,
        message: p.message,
        matchedRows: p.matched_cookie_rows,
        activeRows: p.active_cookie_rows,
        expiredRows: p.expired_cookie_rows,
        premium: p.premium,
        allowed: p.allowed,
        loginDetected: p.login_detected,
      };
    } catch (e) {
      return { kind: "error", message: `Network: ${(e as Error).message}` };
    }
  });

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

export const startDriveJob = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => inputSchema.parse(data))
  .handler(async ({ data }): Promise<DriveStartResult> => {
    const base = process.env.RAILWAY_API_URL?.replace(/\/+$/, "");
    const token = process.env.API_SECRET_TOKEN;
    if (!base || !token) {
      return {
        kind: "error",
        message:
          "Server-e RAILWAY_API_URL ba API_SECRET_TOKEN set nei. Railway API deploy kore secrets add koren.",
      };
    }

    try {
      const res = await fetch(`${base}/download/start`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Token": token,
        },
        body: JSON.stringify(data),
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

      const p = payload as { job_id: string; status: string };
      return { kind: "success", jobId: p.job_id, status: p.status };
    } catch (e) {
      return { kind: "error", message: `Network: ${(e as Error).message}` };
    }
  });

export const getDriveJobStatus = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => jobStatusSchema.parse(data))
  .handler(async ({ data }): Promise<DriveJobStatusResult> => {
    const base = process.env.RAILWAY_API_URL?.replace(/\/+$/, "");
    const token = process.env.API_SECRET_TOKEN;
    if (!base || !token) {
      return { kind: "error", message: "Server-e RAILWAY_API_URL ba API_SECRET_TOKEN set nei." };
    }

    try {
      const res = await fetch(`${base}/download/status/${encodeURIComponent(data.jobId)}`, {
        method: "GET",
        headers: { "X-Api-Token": token },
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
        const detail = typeof detailValue === "string" ? detailValue.trim() : JSON.stringify(detailValue);
        return { kind: "error", message: `Railway API: ${detail || `HTTP ${res.status}`}` };
      }

      const p = payload as {
        job_id: string;
        status: "queued" | "running" | "done" | "error";
        result?: {
          name: string;
          size_mb: number;
          download_seconds: number;
          upload_seconds: number;
          view_link: string | null;
          file_id: string;
        } | null;
        error?: string | null;
      };
      return {
        kind: "success",
        jobId: p.job_id,
        status: p.status,
        error: p.error ?? undefined,
        result: p.result
          ? {
              kind: "success",
              name: p.result.name,
              sizeMb: p.result.size_mb,
              downloadSeconds: p.result.download_seconds,
              uploadSeconds: p.result.upload_seconds,
              viewLink: p.result.view_link,
              fileId: p.result.file_id,
            }
          : undefined,
      };
    } catch (e) {
      return { kind: "error", message: `Network: ${(e as Error).message}` };
    }
  });
