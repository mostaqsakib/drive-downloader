import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { vpsFetch, type Job } from "./downloader.server";

export const submitJob = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z
      .object({
        url: z.string().trim().url({ message: "Valid URL diben" }).max(2048),
        quality: z.enum(["best", "1080p", "720p", "480p", "audio"]),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    return vpsFetch<Job>("/jobs", {
      method: "POST",
      body: JSON.stringify(data),
    });
  });

export const listJobs = createServerFn({ method: "GET" }).handler(async () => {
  return vpsFetch<{ jobs: Job[] }>("/jobs");
});

export const deleteJob = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z.object({ id: z.string().min(1).max(64) }).parse(data),
  )
  .handler(async ({ data }) => {
    return vpsFetch<{ ok: true }>(`/jobs/${encodeURIComponent(data.id)}`, {
      method: "DELETE",
    });
  });
