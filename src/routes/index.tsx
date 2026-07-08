import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import {
  Download,
  Loader2,
  ExternalLink,
  Trash2,
  CheckCircle2,
  XCircle,
  Clock,
  CloudUpload,
  Sparkles,
  Youtube,
  Music2,
  Video,
  ShieldCheck,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Toaster } from "@/components/ui/sonner";
import { submitJob, listJobs, deleteJob } from "@/lib/downloader.functions";
import type { Job } from "@/lib/downloader.server";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "DriveGrabber — Any video → your Google Drive" },
      {
        name: "description",
        content:
          "Paste a URL from YouTube, Facebook, Instagram, TikTok, Twitter/X, Reddit, Vimeo and 1000+ sites. We download it and beam it straight to your Google Drive.",
      },
      { property: "og:title", content: "DriveGrabber — Any video → your Google Drive" },
      {
        property: "og:description",
        content:
          "Universal video downloader that ships files directly to your own Google Drive. No storage limits on our side.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Home,
});

const QUALITY_OPTIONS = [
  { value: "best", label: "Best available" },
  { value: "1080p", label: "1080p" },
  { value: "720p", label: "720p" },
  { value: "480p", label: "480p" },
  { value: "audio", label: "Audio only (MP3)" },
] as const;

function Home() {
  const qc = useQueryClient();
  const submitFn = useServerFn(submitJob);
  const listFn = useServerFn(listJobs);
  const deleteFn = useServerFn(deleteJob);

  const [url, setUrl] = useState("");
  const [quality, setQuality] = useState<(typeof QUALITY_OPTIONS)[number]["value"]>("best");

  const jobsQuery = useQuery({
    queryKey: ["jobs"],
    queryFn: () => listFn(),
    refetchInterval: (q) => {
      const data = q.state.data as { jobs: Job[] } | undefined;
      const hasActive = data?.jobs?.some(
        (j) => j.status === "queued" || j.status === "downloading" || j.status === "uploading",
      );
      return hasActive ? 2500 : false;
    },
  });

  const submitMutation = useMutation({
    mutationFn: () => submitFn({ data: { url: url.trim(), quality } }),
    onSuccess: () => {
      toast.success("Job queued", { description: "VPS ekhon download shuru korche." });
      setUrl("");
      qc.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (err: Error) => toast.error(err.message ?? "Kichu ekta bhul holo"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteFn({ data: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["jobs"] }),
    onError: (err: Error) => toast.error(err.message ?? "Delete korte parlam na"),
  });

  const jobs = jobsQuery.data?.jobs ?? [];
  const notConfigured =
    jobsQuery.isError &&
    /VPS is not configured|VPS_API/i.test((jobsQuery.error as Error)?.message ?? "");

  return (
    <div className="min-h-screen">
      <Toaster theme="dark" position="top-center" richColors />

      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <div className="flex items-center gap-2">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-primary/15 text-primary ring-1 ring-primary/30">
            <CloudUpload className="h-5 w-5" />
          </div>
          <span className="text-lg font-semibold tracking-tight">DriveGrabber</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <ShieldCheck className="h-4 w-4 text-primary" />
          Self-hosted • Private
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 pb-24">
        {/* Hero + form */}
        <section className="pt-8 md:pt-14">
          <div className="mx-auto max-w-3xl text-center">
            <Badge variant="secondary" className="mb-4 border border-primary/30 bg-primary/10 text-primary">
              <Sparkles className="mr-1 h-3 w-3" /> 1000+ sites supported
            </Badge>
            <h1 className="text-4xl font-bold leading-tight md:text-6xl">
              Any video, straight to <span className="text-gradient">your Google Drive.</span>
            </h1>
            <p className="mx-auto mt-4 max-w-xl text-base text-muted-foreground md:text-lg">
              Paste a link. We download it on your VPS and beam the file directly into your Drive —
              no browser downloads, no size limits, no middlemen.
            </p>
          </div>

          <div className="mx-auto mt-10 max-w-3xl glass-card rounded-2xl p-4 md:p-6">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!url.trim()) return toast.error("Ekta URL diben");
                submitMutation.mutate();
              }}
              className="flex flex-col gap-3 md:flex-row"
            >
              <Input
                type="url"
                placeholder="https://www.youtube.com/watch?v=..."
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className="h-12 flex-1 border-border/60 bg-background/60 text-base"
                required
              />
              <Select value={quality} onValueChange={(v) => setQuality(v as typeof quality)}>
                <SelectTrigger className="h-12 md:w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {QUALITY_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="submit"
                disabled={submitMutation.isPending}
                className="h-12 gap-2 bg-primary text-primary-foreground hover:bg-primary/90 md:w-48"
              >
                {submitMutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Sending…
                  </>
                ) : (
                  <>
                    <Download className="h-4 w-4" /> Send to Drive
                  </>
                )}
              </Button>
            </form>

            <div className="mt-4 flex flex-wrap items-center justify-center gap-2 text-xs text-muted-foreground">
              <SiteChip icon={<Youtube className="h-3 w-3" />} label="YouTube" />
              <SiteChip label="Facebook" />
              <SiteChip label="Instagram" />
              <SiteChip label="TikTok" />
              <SiteChip label="Twitter/X" />
              <SiteChip label="Reddit" />
              <SiteChip label="Vimeo" />
              <SiteChip icon={<Music2 className="h-3 w-3" />} label="SoundCloud" />
            </div>
          </div>
        </section>

        {/* Jobs */}
        <section className="mt-16">
          <div className="mb-4 flex items-end justify-between">
            <div>
              <h2 className="text-2xl font-semibold">Your jobs</h2>
              <p className="text-sm text-muted-foreground">
                Live status • auto-refreshes while downloading
              </p>
            </div>
            {jobsQuery.isFetching && !jobsQuery.isLoading && (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            )}
          </div>

          {notConfigured ? (
            <NotConfigured />
          ) : jobsQuery.isLoading ? (
            <SkeletonList />
          ) : jobs.length === 0 ? (
            <EmptyState />
          ) : (
            <ul className="space-y-3">
              {jobs.map((j) => (
                <JobRow
                  key={j.id}
                  job={j}
                  onDelete={() => deleteMutation.mutate(j.id)}
                  deleting={deleteMutation.isPending && deleteMutation.variables === j.id}
                />
              ))}
            </ul>
          )}
        </section>
      </main>

      <footer className="border-t border-border/50 py-6 text-center text-xs text-muted-foreground">
        Powered by yt-dlp + rclone • Your VPS, your Drive, your rules.
      </footer>
    </div>
  );
}

function SiteChip({ icon, label }: { icon?: React.ReactNode; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/40 px-2.5 py-1">
      {icon}
      {label}
    </span>
  );
}

function StatusBadge({ status }: { status: Job["status"] }) {
  const map: Record<Job["status"], { label: string; cls: string; icon: React.ReactNode }> = {
    queued: {
      label: "Queued",
      cls: "bg-muted text-muted-foreground",
      icon: <Clock className="h-3 w-3" />,
    },
    downloading: {
      label: "Downloading",
      cls: "bg-primary/15 text-primary ring-1 ring-primary/30",
      icon: <Loader2 className="h-3 w-3 animate-spin" />,
    },
    uploading: {
      label: "Uploading",
      cls: "bg-accent/15 text-accent ring-1 ring-accent/30",
      icon: <CloudUpload className="h-3 w-3" />,
    },
    done: {
      label: "Done",
      cls: "bg-success/15 text-success ring-1 ring-success/30",
      icon: <CheckCircle2 className="h-3 w-3" />,
    },
    failed: {
      label: "Failed",
      cls: "bg-destructive/15 text-destructive ring-1 ring-destructive/30",
      icon: <XCircle className="h-3 w-3" />,
    },
  };
  const m = map[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${m.cls}`}>
      {m.icon} {m.label}
    </span>
  );
}

function JobRow({
  job,
  onDelete,
  deleting,
}: {
  job: Job;
  onDelete: () => void;
  deleting: boolean;
}) {
  const active = job.status === "downloading" || job.status === "uploading";
  return (
    <li className="glass-card flex flex-col gap-3 rounded-xl p-4 md:flex-row md:items-center md:justify-between">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <StatusBadge status={job.status} />
          <span className="text-xs text-muted-foreground">
            {new Date(job.createdAt).toLocaleString()}
          </span>
        </div>
        <div className="mt-1.5 truncate text-sm font-medium">
          {job.title || job.filename || job.url}
        </div>
        <div className="truncate text-xs text-muted-foreground">{job.url}</div>
        {active && typeof job.progress === "number" && (
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${Math.min(100, Math.max(0, job.progress))}%` }}
            />
          </div>
        )}
        {job.error && (
          <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-xs text-destructive">
            {job.error}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 md:ml-4">
        {job.driveLink && (
          <a href={job.driveLink} target="_blank" rel="noopener noreferrer">
            <Button size="sm" className="gap-1.5 bg-accent text-accent-foreground hover:bg-accent/90">
              <ExternalLink className="h-3.5 w-3.5" /> Open in Drive
            </Button>
          </a>
        )}
        <Button
          size="icon"
          variant="ghost"
          onClick={onDelete}
          disabled={deleting}
          aria-label="Delete job"
        >
          {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
        </Button>
      </div>
    </li>
  );
}

function EmptyState() {
  return (
    <div className="glass-card rounded-2xl p-10 text-center">
      <Video className="mx-auto mb-3 h-10 w-10 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">
        No jobs yet. Paste a link uporer form e — Drive e chole jabe.
      </p>
    </div>
  );
}

function SkeletonList() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="glass-card h-20 animate-pulse rounded-xl" />
      ))}
    </div>
  );
}

function NotConfigured() {
  return (
    <div className="glass-card rounded-2xl p-8">
      <h3 className="text-lg font-semibold">VPS is not connected yet</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Ei site kaaj korar age apnar VPS e yt-dlp API server chalate hobe. Full setup guide project
        er <code className="rounded bg-muted px-1.5 py-0.5">/vps/README.md</code> e ache.
      </p>
      <ol className="mt-4 list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
        <li>VPS e <code className="rounded bg-muted px-1 py-0.5">vps/</code> folder er sob file copy koren.</li>
        <li><code className="rounded bg-muted px-1 py-0.5">bash install.sh</code> chalan.</li>
        <li><code className="rounded bg-muted px-1 py-0.5">rclone config</code> diye Google Drive connect koren (remote name: <code>gdrive</code>).</li>
        <li>Ei project e <b>VPS_API_URL</b> ar <b>VPS_API_TOKEN</b> secret set koren.</li>
      </ol>
    </div>
  );
}
