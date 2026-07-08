// Server-only helpers for talking to the user's VPS running yt-dlp + rclone.
export interface Job {
  id: string;
  url: string;
  quality: string;
  status: "queued" | "downloading" | "uploading" | "done" | "failed";
  title?: string;
  filename?: string;
  driveLink?: string;
  error?: string;
  progress?: number;
  createdAt: string;
  updatedAt: string;
}

function getConfig() {
  const base = process.env.VPS_API_URL;
  const token = process.env.VPS_API_TOKEN;
  if (!base || !token) {
    throw new Error(
      "VPS is not configured. Add VPS_API_URL and VPS_API_TOKEN in project secrets.",
    );
  }
  return { base: base.replace(/\/$/, ""), token };
}

export async function vpsFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const { base, token } = getConfig();
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `VPS request failed [${res.status}]: ${text.slice(0, 400) || res.statusText}`,
    );
  }
  return text ? (JSON.parse(text) as T) : (undefined as T);
}
