import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Download,
  Loader2,
  ExternalLink,
  Sparkles,
  Youtube,
  Music2,
  ShieldCheck,
  Link2,
  HardDrive,
  CheckCircle2,
  XCircle,
  X,
  KeyRound,
  Trash2,
  Cookie,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Toaster } from "@/components/ui/sonner";
import { fetchDownload } from "@/lib/downloader.functions";
import { saveToDrive, type DriveResult } from "@/lib/drive-upload.functions";
import {
  canonicalHost,
  hostFromUrl,
  loadCookies,
  pickCookiesFor,
  saveCookies,
  type CookieEntry,
} from "@/lib/cookie-store";


export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "DriveGrabber — Fast video downloader for 30+ sites" },
      {
        name: "description",
        content:
          "Paste a link from YouTube, TikTok, Instagram, Twitter/X, Reddit, Vimeo, SoundCloud and more. Get a clean direct download in seconds — no ads, no signup.",
      },
      { property: "og:title", content: "DriveGrabber — Fast video downloader" },
      {
        property: "og:description",
        content: "Universal video & audio downloader. Paste a link, get the file.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Home,
});

const MODE_OPTIONS = [
  { value: "auto", label: "Video + Audio" },
  { value: "audio", label: "Audio only (MP3)" },
  { value: "mute", label: "Video only (mute)" },
] as const;

const QUALITY_OPTIONS = [
  { value: "max", label: "Max quality" },
  { value: "1080", label: "1080p" },
  { value: "720", label: "720p" },
  { value: "480", label: "480p" },
  { value: "360", label: "360p" },
] as const;

type Mode = (typeof MODE_OPTIONS)[number]["value"];
type Quality = (typeof QUALITY_OPTIONS)[number]["value"];

type JobStatus = "queued" | "running" | "done" | "error";

type Job = {
  id: string;
  url: string;
  mode: Mode;
  quality: Quality;
  toDrive: boolean;
  status: JobStatus;
  startedAt: number;
  endedAt?: number;
  result?: DriveResult | { kind: "link"; url: string; filename?: string | null };
  error?: string;
};

function Home() {
  const runFn = useServerFn(fetchDownload);
  const driveFn = useServerFn(saveToDrive);

  const [url, setUrl] = useState("");
  const [mode, setMode] = useState<Mode>("auto");
  const [quality, setQuality] = useState<Quality>("1080");
  const [toDrive, setToDrive] = useState(true);
  const [jobs, setJobs] = useState<Job[]>([]);

  const updateJob = (id: string, patch: Partial<Job>) =>
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...patch } : j)));

  const startJob = async (job: Job) => {
    updateJob(job.id, { status: "running", startedAt: Date.now() });
    try {
      if (job.toDrive) {
        const cookies = pickCookiesFor(job.url)?.cookies;
        const r = await driveFn({
          data: { url: job.url, mode: job.mode, quality: job.quality, cookies },
        });

        if (r.kind === "success") {
          updateJob(job.id, { status: "done", endedAt: Date.now(), result: r });
          toast.success("Drive-e upload complete!", { description: r.name });
        } else {
          updateJob(job.id, {
            status: "error",
            endedAt: Date.now(),
            error: r.message,
          });
          toast.error(r.message);
        }
      } else {
        const r = await runFn({
          data: { url: job.url, mode: job.mode, quality: job.quality },
        });
        if (r.kind === "tunnel" || r.kind === "redirect") {
          updateJob(job.id, {
            status: "done",
            endedAt: Date.now(),
            result: { kind: "link", url: r.url, filename: r.filename },
          });
          window.open(r.url, "_blank", "noopener,noreferrer");
          toast.success("Download ready!");
        } else if (r.kind === "picker") {
          const first = r.items[0]?.url;
          if (first) {
            updateJob(job.id, {
              status: "done",
              endedAt: Date.now(),
              result: { kind: "link", url: first },
            });
            toast.success(`${r.items.length} items ready`);
          } else {
            updateJob(job.id, {
              status: "error",
              endedAt: Date.now(),
              error: "No items",
            });
          }
        } else if (r.kind === "error") {
          updateJob(job.id, {
            status: "error",
            endedAt: Date.now(),
            error: r.message,
          });
          toast.error(r.message);
        }

      }
    } catch (e) {
      const msg = (e as Error).message ?? "Unknown error";
      updateJob(job.id, { status: "error", endedAt: Date.now(), error: msg });
      toast.error(msg);
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) return toast.error("Ekta URL diben");
    const job: Job = {
      id: crypto.randomUUID(),
      url: trimmed,
      mode,
      quality,
      toDrive,
      status: "queued",
      startedAt: Date.now(),
    };
    setJobs((prev) => [job, ...prev]);
    setUrl("");
    // Fire-and-forget — jobs run in parallel
    void startJob(job);
  };

  const removeJob = (id: string) =>
    setJobs((prev) => prev.filter((j) => j.id !== id));
  const clearFinished = () =>
    setJobs((prev) => prev.filter((j) => j.status === "running" || j.status === "queued"));

  const activeCount = jobs.filter((j) => j.status === "running").length;

  return (
    <div className="min-h-screen">
      <Toaster theme="dark" position="top-center" richColors />

      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <div className="flex items-center gap-2">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-primary/15 text-primary ring-1 ring-primary/30">
            <Download className="h-5 w-5" />
          </div>
          <span className="text-lg font-semibold tracking-tight">DriveGrabber</span>
        </div>
        <div className="flex items-center gap-3">
          <CookieManager currentUrl={url} />
          <div className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex">
            <ShieldCheck className="h-4 w-4 text-primary" />
            No ads • No signup
          </div>
        </div>

      </header>

      <main className="mx-auto max-w-6xl px-6 pb-24">
        <section className="pt-8 md:pt-14">
          <div className="mx-auto max-w-3xl text-center">
            <Badge
              variant="secondary"
              className="mb-4 border border-primary/30 bg-primary/10 text-primary"
            >
              <Sparkles className="mr-1 h-3 w-3" /> Multiple downloads at once
            </Badge>
            <h1 className="text-4xl font-bold leading-tight md:text-6xl">
              Paste a link. <span className="text-gradient">Get the file.</span>
            </h1>
            <p className="mx-auto mt-4 max-w-xl text-base text-muted-foreground md:text-lg">
              Ekta submit koren, sathe sathe arekta — jotogula khushi. Sob parallel-e cholbe,
              progress niche dekhben.
            </p>
          </div>

          <div className="glass-card mx-auto mt-10 max-w-3xl rounded-2xl p-4 md:p-6">
            <form onSubmit={submit} className="flex flex-col gap-3">
              <div className="relative">
                <Link2 className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="url"
                  placeholder="https://www.youtube.com/watch?v=..."
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  className="h-12 border-border/60 bg-background/60 pl-9 text-base"
                  required
                />
              </div>
              <div className="flex flex-col gap-3 md:flex-row">
                <Select value={mode} onValueChange={(v) => setMode(v as Mode)}>
                  <SelectTrigger className="h-12 flex-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MODE_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={quality}
                  onValueChange={(v) => setQuality(v as Quality)}
                  disabled={mode === "audio"}
                >
                  <SelectTrigger className="h-12 flex-1">
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
                  className="h-12 gap-2 bg-primary text-primary-foreground hover:bg-primary/90 md:w-48"
                >
                  {toDrive ? <HardDrive className="h-4 w-4" /> : <Download className="h-4 w-4" />}
                  {toDrive ? "Add to queue" : "Download"}
                </Button>
              </div>

              <div className="flex items-center justify-between rounded-xl border border-border/60 bg-background/40 px-4 py-3">
                <div className="flex items-center gap-2">
                  <HardDrive className="h-4 w-4 text-primary" />
                  <Label htmlFor="to-drive" className="cursor-pointer text-sm">
                    Save directly to Google Drive
                    <span className="ml-2 text-xs text-muted-foreground">
                      (boro file, adult sites, jekono URL)
                    </span>
                  </Label>
                </div>
                <Switch id="to-drive" checked={toDrive} onCheckedChange={setToDrive} />
              </div>
            </form>

            <div className="mt-4 flex flex-wrap items-center justify-center gap-2 text-xs text-muted-foreground">
              <SiteChip icon={<Youtube className="h-3 w-3" />} label="YouTube" />
              <SiteChip label="TikTok" />
              <SiteChip label="Instagram" />
              <SiteChip label="Twitter/X" />
              <SiteChip label="Reddit" />
              <SiteChip label="Vimeo" />
              <SiteChip label="Facebook" />
              <SiteChip icon={<Music2 className="h-3 w-3" />} label="SoundCloud" />
            </div>
          </div>

          {jobs.length > 0 && (
            <div className="mx-auto mt-8 max-w-3xl">
              <div className="mb-3 flex items-center justify-between px-1">
                <div className="text-sm text-muted-foreground">
                  {activeCount > 0 ? (
                    <>
                      <Loader2 className="mr-1.5 inline h-3.5 w-3.5 animate-spin text-primary" />
                      {activeCount} running • {jobs.length} total
                    </>
                  ) : (
                    <>{jobs.length} job{jobs.length > 1 ? "s" : ""}</>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearFinished}
                  className="h-7 text-xs text-muted-foreground hover:text-foreground"
                >
                  Clear finished
                </Button>
              </div>
              <div className="flex flex-col gap-3">
                {jobs.map((j) => (
                  <JobCard key={j.id} job={j} onRemove={() => removeJob(j.id)} />
                ))}
              </div>
            </div>
          )}
        </section>

        <section className="mt-20 grid gap-4 md:grid-cols-3">
          <FeatureCard
            title="Parallel"
            body="Ekta submit korei arektay jete paren — sob parallel-e cholbe."
          />
          <FeatureCard
            title="Private"
            body="Kono account lage na, kono log rakha hoy na. Just paste ar download."
          />
          <FeatureCard
            title="Universal"
            body="YouTube, TikTok, IG, Twitter, Reddit, Vimeo, SoundCloud — shob support."
          />
        </section>
      </main>

      <footer className="border-t border-border/50 py-6 text-center text-xs text-muted-foreground">
        Powered by cobalt.tools • Respect creators — download only what you own or have rights to.
      </footer>
    </div>
  );
}

function JobCard({ job, onRemove }: { job: Job; onRemove: () => void }) {
  const [, tick] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (job.status === "running") {
      timerRef.current = setInterval(() => tick((n) => n + 1), 500);
      return () => {
        if (timerRef.current) clearInterval(timerRef.current);
      };
    }
  }, [job.status]);

  const elapsed = Math.max(
    0,
    Math.floor(((job.endedAt ?? Date.now()) - job.startedAt) / 1000),
  );

  const phaseText =
    job.status === "running"
      ? job.toDrive
        ? elapsed < 30
          ? "Downloading from source…"
          : "Uploading to Google Drive…"
        : "Fetching link…"
      : job.status === "done"
        ? "Complete"
        : job.status === "error"
          ? "Failed"
          : "Queued";

  return (
    <div className="glass-card rounded-xl p-4">
      <div className="flex items-start gap-3">
        <div className="mt-0.5">
          {job.status === "running" && (
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          )}
          {job.status === "done" && <CheckCircle2 className="h-5 w-5 text-primary" />}
          {job.status === "error" && <XCircle className="h-5 w-5 text-destructive" />}
          {job.status === "queued" && (
            <div className="h-5 w-5 rounded-full border-2 border-dashed border-muted-foreground/50" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{job.url}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <span>{phaseText}</span>
            <span>•</span>
            <span>{elapsed}s</span>
            <span>•</span>
            <span>
              {job.toDrive ? "Drive" : "Direct"} · {job.mode} · {job.quality}
            </span>
          </div>

          {job.status === "running" && (
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full w-1/3 animate-[progress_1.4s_ease-in-out_infinite] rounded-full bg-primary" />
            </div>
          )}

          {job.status === "done" && job.result && (
            <div className="mt-3">
              {job.result.kind === "success" && (
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 text-xs text-muted-foreground">
                    <span className="text-foreground">{job.result.name}</span> •{" "}
                    {job.result.sizeMb} MB • dl {job.result.downloadSeconds}s • up{" "}
                    {job.result.uploadSeconds}s
                  </div>
                  {job.result.viewLink && (
                    <a
                      href={job.result.viewLink}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Button
                        size="sm"
                        className="h-8 gap-1.5 bg-accent text-accent-foreground hover:bg-accent/90"
                      >
                        <ExternalLink className="h-3.5 w-3.5" /> Open in Drive
                      </Button>
                    </a>
                  )}
                </div>
              )}
              {job.result.kind === "link" && (
                <a href={job.result.url} target="_blank" rel="noopener noreferrer">
                  <Button
                    size="sm"
                    className="h-8 gap-1.5 bg-accent text-accent-foreground hover:bg-accent/90"
                  >
                    <ExternalLink className="h-3.5 w-3.5" /> Open link
                  </Button>
                </a>
              )}
            </div>
          )}

          {job.status === "error" && job.error && (
            <div className="mt-2 text-xs text-destructive">{job.error}</div>
          )}
        </div>
        <button
          onClick={onRemove}
          className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Remove"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
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

function FeatureCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="glass-card rounded-2xl p-6">
      <div className="text-lg font-semibold">{title}</div>
      <p className="mt-1 text-sm text-muted-foreground">{body}</p>
    </div>
  );
}
