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
  RotateCcw,
  BarChart3,
  TrendingUp,
  Clock,
  AlertCircle,
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
import {
  checkCookieAccess,
  getDriveJobStatus,
  startDriveJob,
  type CookieCheckResult,
  type DriveResult,
} from "@/lib/drive-upload.functions";
import {
  canonicalHost,
  hostFromUrl,
  loadCookies,
  pickCookiesFor,
  saveCookies,
  summarizeCookies,
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
      { property: "og:title", content: "DriveGrabber — Fast video downloader for 30+ sites" },
      {
        property: "og:description",
        content: "Paste a link from YouTube, TikTok, Instagram, Twitter/X, Reddit, Vimeo, SoundCloud and more. Get a clean direct download in seconds — no ads, no signup.",
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


type Mode = (typeof MODE_OPTIONS)[number]["value"];
type Quality = "max" | "1080" | "720" | "480" | "360";

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
  cookieDomain?: string;
  phase?: string;
  downloadProgress?: number;
  uploadProgress?: number;
  downloadedBytes?: number;
  totalBytes?: number;
  uploadedBytes?: number;
  uploadTotalBytes?: number;
  attempts?: number;
};

const MAX_AUTO_RETRIES = 3;
const AUTO_RETRY_DELAY_MS = 4000;

function Home() {
  const runFn = useServerFn(fetchDownload);
  const startDriveFn = useServerFn(startDriveJob);
  const getDriveStatusFn = useServerFn(getDriveJobStatus);

  const [urlsText, setUrlsText] = useState("");
  const [mode, setMode] = useState<Mode>("auto");
  const quality: Quality = "max";
  const [toDrive, setToDrive] = useState(true);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [hydrated, setHydrated] = useState(false);

  const parsedUrls = urlsText
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const validUrls = parsedUrls.filter((l) => {
    try {
      new URL(l);
      return true;
    } catch {
      return false;
    }
  });

  // Load persisted history on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem("dg_jobs_v1");
      if (raw) {
        const parsed = JSON.parse(raw) as Job[];
        // Any in-flight jobs from a previous session can't be resumed —
        // mark them failed so the user can retry.
        const restored = parsed.map((j) =>
          j.status === "running" || j.status === "queued"
            ? {
                ...j,
                status: "error" as JobStatus,
                endedAt: j.endedAt ?? Date.now(),
                error:
                  j.error ||
                  "Page reload hoyeche — job er progress hariye geche. Retry koren.",
              }
            : j,
        );
        setJobs(restored);
      }
    } catch {
      // ignore corrupt storage
    }
    setHydrated(true);
  }, []);

  // Persist to localStorage whenever jobs change (after hydration)
  useEffect(() => {
    if (!hydrated) return;
    try {
      // Cap at 200 items to keep storage sane
      const trimmed = jobs.slice(0, 200);
      localStorage.setItem("dg_jobs_v1", JSON.stringify(trimmed));
    } catch {
      // quota exceeded — ignore
    }
  }, [jobs, hydrated]);

  const updateJob = (id: string, patch: Partial<Job>) =>
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...patch } : j)));

  const startJob = async (job: Job) => {
    const attempts = job.attempts ?? 0;
    updateJob(job.id, { status: "running", startedAt: Date.now(), attempts, error: undefined });

    const failOrRetry = (message: string, opts?: { silent?: boolean }) => {
      const nextAttempts = attempts + 1;
      if (nextAttempts <= MAX_AUTO_RETRIES) {
        const label = `Retry ${nextAttempts}/${MAX_AUTO_RETRIES}: ${message}`;
        updateJob(job.id, {
          status: "queued",
          error: label,
          attempts: nextAttempts,
          phase: `auto-retry ${nextAttempts}/${MAX_AUTO_RETRIES}`,
        });
        if (!opts?.silent) toast.message(`Auto-retry (${nextAttempts}/${MAX_AUTO_RETRIES})`, { description: message });
        setTimeout(() => {
          void startJob({ ...job, attempts: nextAttempts });
        }, AUTO_RETRY_DELAY_MS);
        return;
      }
      updateJob(job.id, { status: "error", endedAt: Date.now(), error: message, attempts: nextAttempts });
      if (!opts?.silent) toast.error(message);
    };

    try {
      if (job.toDrive) {
        const matchedCookies = pickCookiesFor(job.url);
        const cookies = matchedCookies?.cookies;
        updateJob(job.id, { cookieDomain: matchedCookies?.domain ?? "none" });
        const started = await startDriveFn({
          data: { url: job.url, mode: job.mode, quality: job.quality, cookies, clientJobId: job.id },
        });

        if (started.kind === "error") {
          failOrRetry(started.message);
          return;
        }

        const pollStartedAt = Date.now();
        while (Date.now() - pollStartedAt < 15 * 60 * 1000) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          const status = await getDriveStatusFn({ data: { jobId: started.jobId } });
          if (status.kind === "error") {
            failOrRetry(status.message);
            return;
          }
          updateJob(job.id, {
            phase: status.phase ?? undefined,
            downloadProgress: status.downloadProgress ?? undefined,
            uploadProgress: status.uploadProgress ?? undefined,
            downloadedBytes: status.downloadedBytes ?? undefined,
            totalBytes: status.totalBytes ?? undefined,
            uploadedBytes: status.uploadedBytes ?? undefined,
            uploadTotalBytes: status.uploadTotalBytes ?? undefined,
          });
          if (status.status === "done" && status.result) {
            updateJob(job.id, { status: "done", endedAt: Date.now(), result: status.result });
            toast.success("Drive-e upload complete!", { description: status.result.name });
            return;
          }
          if (status.status === "error") {
            const message = status.error || "Load failed";
            failOrRetry(message);
            return;
          }
        }
        failOrRetry("Download/upload timeout — auto-retry cholche (resume korbe).");
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
            failOrRetry("No items");
          }
        } else if (r.kind === "error") {
          failOrRetry(r.message);
        }
      }
    } catch (e) {
      const msg = (e as Error).message ?? "Unknown error";
      failOrRetry(msg);
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (validUrls.length === 0) {
      if (parsedUrls.length > 0) {
        return toast.error("Kono valid URL pawa jayni. Proti line-te ekta link thaka uchit.");
      }
      return toast.error("Ekta URL diben");
    }

    const newJobs: Job[] = validUrls.map((u) => ({
      id: crypto.randomUUID(),
      url: u,
      mode,
      quality,
      toDrive,
      status: "queued",
      startedAt: Date.now(),
    }));

    setJobs((prev) => [...newJobs, ...prev]);
    setUrlsText("");
    // Fire-and-forget — jobs run in parallel
    newJobs.forEach((job) => void startJob(job));
    toast.success(`${newJobs.length} ta URL queue-te add holo`, {
      description: toDrive ? "Sob Drive-e upload hobe" : "Direct download link toiri hobe",
    });
  };

  const removeJob = (id: string) =>
    setJobs((prev) => prev.filter((j) => j.id !== id));
  const clearFinished = () =>
    setJobs((prev) => prev.filter((j) => j.status === "running" || j.status === "queued"));
  const clearHistory = () => {
    if (!confirm("Puro history mucbe? Running jobs thakbe.")) return;
    setJobs((prev) => prev.filter((j) => j.status === "running" || j.status === "queued"));
  };
  const retryJob = (id: string) => {
    const old = jobs.find((j) => j.id === id);
    if (!old) return;
    const retried: Job = {
      id: crypto.randomUUID(),
      url: old.url,
      mode: old.mode,
      quality: old.quality,
      toDrive: old.toDrive,
      status: "queued",
      startedAt: Date.now(),
    };
    // Replace failed job with fresh queued one at the same spot
    setJobs((prev) => prev.map((j) => (j.id === id ? retried : j)));
    void startJob(retried);
  };

  const activeCount = jobs.filter((j) => j.status === "running").length;
  const queuedCount = jobs.filter((j) => j.status === "queued").length;
  const doneCount = jobs.filter((j) => j.status === "done").length;
  const failedCount = jobs.filter((j) => j.status === "error").length;

  const statusPriority = (s: JobStatus) =>
    s === "running" ? 0 : s === "queued" ? 1 : s === "error" ? 2 : 3;
  const sortedJobs = [...jobs].sort(
    (a, b) => statusPriority(a.status) - statusPriority(b.status) || b.startedAt - a.startedAt,
  );


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
          <CookieManager currentUrl={validUrls[0] ?? ""} />
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
                <Link2 className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                <Textarea
                  placeholder={"https://www.youtube.com/watch?v=...\nhttps://www.tiktok.com/@user/video/...\n(ek line-e ekta link — jotogula khushi)"}
                  value={urlsText}
                  onChange={(e) => setUrlsText(e.target.value)}
                  className="min-h-[100px] border-border/60 bg-background/60 pl-9 pt-2.5 text-base"
                  required={validUrls.length === 0}
                />
                {validUrls.length > 1 && (
                  <div className="absolute bottom-2 right-2 rounded-md bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                    {validUrls.length} links ready
                  </div>
                )}
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
                <Button
                  type="submit"
                  className="h-12 gap-2 bg-primary text-primary-foreground hover:bg-primary/90 md:w-48"
                >
                  {toDrive ? <HardDrive className="h-4 w-4" /> : <Download className="h-4 w-4" />}
                  {toDrive
                    ? validUrls.length > 1
                      ? `Add ${validUrls.length} to queue`
                      : "Add to queue"
                    : validUrls.length > 1
                      ? `Download ${validUrls.length}`
                      : "Download"}
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
                <div className="flex flex-wrap items-center gap-2">
                  {activeCount > 0 && (
                    <Badge className="gap-1 bg-primary text-primary-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      {activeCount} downloading
                    </Badge>
                  )}
                  {queuedCount > 0 && (
                    <Badge variant="secondary">{queuedCount} queued</Badge>
                  )}
                  {doneCount > 0 && (
                    <Badge
                      variant="outline"
                      className="border-primary/30 text-primary"
                    >
                      {doneCount} uploaded
                    </Badge>
                  )}
                  {failedCount > 0 && (
                    <Badge variant="destructive">{failedCount} failed</Badge>
                  )}
                  <span className="text-sm text-muted-foreground">
                    • {jobs.length} total
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={clearFinished}
                    className="h-7 text-xs text-muted-foreground hover:text-foreground"
                  >
                    Clear finished
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={clearHistory}
                    className="h-7 text-xs text-muted-foreground hover:text-destructive"
                  >
                    Clear history
                  </Button>
                </div>
              </div>
              <div className="flex flex-col gap-3">
                {sortedJobs.map((j) => (
                  <JobCard
                    key={j.id}
                    job={j}
                    onRemove={() => removeJob(j.id)}
                    onRetry={() => retryJob(j.id)}
                  />
                ))}
              </div>
            </div>
          )}

        </section>

        {jobs.length > 0 && <StatsDashboard jobs={jobs} />}

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

    </div>
  );
}

function CookieManager({ currentUrl }: { currentUrl: string }) {
  const checkFn = useServerFn(checkCookieAccess);
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<CookieEntry[]>([]);
  const [domain, setDomain] = useState("");
  const [label, setLabel] = useState("");
  const [cookies, setCookies] = useState("");
  const [checkingDomain, setCheckingDomain] = useState<string | null>(null);
  const [checkResults, setCheckResults] = useState<Record<string, CookieCheckResult>>({});

  useEffect(() => {
    if (open) setEntries(loadCookies());
  }, [open]);

  // Auto-suggest the domain based on the URL the user is about to submit.
  useEffect(() => {
    if (!open) return;
    const host = hostFromUrl(currentUrl);
    if (host && !domain) setDomain(host);
  }, [open, currentUrl, domain]);

  const persist = (next: CookieEntry[]) => {
    setEntries(next);
    saveCookies(next);
  };

  const addOrUpdate = () => {
    const d = canonicalHost(domain.trim());
    const c = cookies.trim();
    if (!d) return toast.error("Domain diben (e.g. youtube.com)");
    if (!c) return toast.error("Cookies text paste koren");
    if (!/^#|\t/m.test(c)) {
      toast.warning("Ei text Netscape cookies.txt format er moto lagche na — tobuo save korchi");
    }
    const next: CookieEntry[] = [
      ...entries.filter((e) => e.domain !== d),
      { domain: d, label: label.trim() || undefined, cookies: c, updatedAt: Date.now() },
    ].sort((a, b) => a.domain.localeCompare(b.domain));
    persist(next);
    setDomain("");
    setLabel("");
    setCookies("");
    toast.success(`${d} — cookies saved`);
  };

  const remove = (d: string) => {
    persist(entries.filter((e) => e.domain !== d));
  };

  const editExisting = (e: CookieEntry) => {
    setDomain(e.domain);
    setLabel(e.label ?? "");
    setCookies(e.cookies);
  };

  const checkExisting = async (e: CookieEntry) => {
    const targetUrl = hostFromUrl(currentUrl) ? currentUrl : `https://${e.domain}/`;
    setCheckingDomain(e.domain);
    try {
      const result = await checkFn({ data: { url: targetUrl, cookies: e.cookies } });
      setCheckResults((prev) => ({ ...prev, [e.domain]: result }));
      if (result.kind === "success" && result.ok) toast.success(result.message);
      else toast.error(result.message);
    } catch (error) {
      const result = { kind: "error" as const, message: (error as Error).message };
      setCheckResults((prev) => ({ ...prev, [e.domain]: result }));
      toast.error(result.message);
    } finally {
      setCheckingDomain(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Cookie className="h-4 w-4" />
          Cookies
          {entries.length > 0 && (
            <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px]">
              {entries.length}
            </Badge>
          )}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-primary" />
            Cookie vault (premium sites)
          </DialogTitle>
          <DialogDescription>
            Premium / login-locked site (Patreon, private YouTube, Fansly, etc.) er jonno
            <strong className="text-foreground"> Netscape cookies.txt </strong>
            paste koren. Domain match hole shei cookies auto-attach hobe.
            Data shudhu apnar browser-e thake.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-2 rounded-lg border border-border/60 bg-background/40 p-3 text-xs text-muted-foreground">
          <div className="mb-1 font-medium text-foreground">Kivabe cookies bar korben?</div>
          Chrome/Firefox-e{" "}
          <a
            href="https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline"
          >
            "Get cookies.txt LOCALLY"
          </a>{" "}
          extension install koren → site-e login thakle icon click → Export → shei text
          niche paste koren.
        </div>

        <div className="mt-4 grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="ck-domain" className="text-xs">
                Domain
              </Label>
              <Input
                id="ck-domain"
                placeholder="youtube.com"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                className="mt-1 h-9"
              />
            </div>
            <div>
              <Label htmlFor="ck-label" className="text-xs">
                Label (optional)
              </Label>
              <Input
                id="ck-label"
                placeholder="My premium account"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                className="mt-1 h-9"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="ck-text" className="text-xs">
              cookies.txt content
            </Label>
            <Textarea
              id="ck-text"
              placeholder="# Netscape HTTP Cookie File&#10;.youtube.com&#9;TRUE&#9;/&#9;TRUE&#9;..."
              value={cookies}
              onChange={(e) => setCookies(e.target.value)}
              className="mt-1 min-h-[140px] font-mono text-xs"
            />
          </div>
          <Button onClick={addOrUpdate} className="w-full">
            {entries.some((e) => e.domain === canonicalHost(domain.trim()))
              ? "Update cookies"
              : "Save cookies"}
          </Button>
        </div>

        {entries.length > 0 && (
          <div className="mt-6">
            <div className="mb-2 text-xs font-medium text-muted-foreground">
              Saved ({entries.length})
            </div>
            <div className="flex flex-col gap-2">
              {entries.map((e) => (
                <CookieEntryRow
                  key={e.domain}
                  entry={e}
                  result={checkResults[e.domain]}
                  checking={checkingDomain === e.domain}
                  onCheck={() => void checkExisting(e)}
                  onEdit={() => editExisting(e)}
                  onRemove={() => remove(e.domain)}
                />
              ))}
            </div>
          </div>
        )}

        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={() => setOpen(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CookieEntryRow({
  entry,
  result,
  checking,
  onCheck,
  onEdit,
  onRemove,
}: {
  entry: CookieEntry;
  result?: CookieCheckResult;
  checking: boolean;
  onCheck: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const summary = summarizeCookies(entry.cookies);
  const expiryText = summary.earliestExpiry
    ? `expires ${new Date(summary.earliestExpiry * 1000).toLocaleDateString()}`
    : summary.sessionRows > 0
      ? "session cookies"
      : "no expiry found";

  return (
    <div className="rounded-lg border border-border/60 bg-background/40 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">{entry.domain}</div>
          <div className="text-xs text-muted-foreground">
            {entry.label ?? "—"} • {(entry.cookies.length / 1024).toFixed(1)} KB •{" "}
            {summary.activeRows}/{summary.totalRows || 0} active • {summary.expiredRows} expired •{" "}
            {expiryText}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="secondary" onClick={onCheck} disabled={checking} className="h-8">
            {checking ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
            Check
          </Button>
          <Button size="sm" variant="ghost" onClick={onEdit} className="h-8">
            Edit
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onRemove}
            className="h-8 text-destructive hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      {summary.domains.length > 0 && (
        <div className="mt-2 truncate text-[11px] text-muted-foreground">
          Cookie domains: {summary.domains.slice(0, 4).join(", ")}
          {summary.domains.length > 4 ? "…" : ""}
        </div>
      )}
      {result && (
        <div
          className={`mt-2 rounded-md border px-2 py-1.5 text-xs ${
            result.kind === "success" && result.ok
              ? "border-primary/30 bg-primary/10 text-primary"
              : "border-destructive/30 bg-destructive/10 text-destructive"
          }`}
        >
          {result.message}
          {result.kind === "success" && (
            <span className="mt-1 block text-[11px] opacity-80">
              matched {result.matchedRows}, active {result.activeRows}, expired {result.expiredRows}
              {typeof result.premium === "boolean" ? ` • premium: ${result.premium ? "yes" : "no"}` : ""}
              {typeof result.allowed === "boolean" ? ` • allowed: ${result.allowed ? "yes" : "no"}` : ""}
              {typeof result.loginDetected === "boolean"
                ? ` • login: ${result.loginDetected ? "detected" : "not detected"}`
                : ""}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ job }: { job: Job }) {
  if (job.status === "queued") {
    return (
      <Badge variant="outline" className="shrink-0">
        Queued
      </Badge>
    );
  }
  if (job.status === "running") {
    const label =
      job.phase === "uploading"
        ? "Uploading"
        : job.phase === "downloading" || job.phase === "processing"
          ? "Downloading"
          : "Processing";
    return (
      <Badge className="shrink-0 gap-1 bg-primary text-primary-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        {label}
      </Badge>
    );
  }
  if (job.status === "done") {
    return (
      <Badge
        variant="outline"
        className="shrink-0 border-primary/30 text-primary"
      >
        {job.toDrive ? "Uploaded" : "Ready"}
      </Badge>
    );
  }
  return (
    <Badge variant="destructive" className="shrink-0">
      Failed
    </Badge>
  );
}

function JobCard({

  job,
  onRemove,
  onRetry,
}: {
  job: Job;
  onRemove: () => void;
  onRetry: () => void;
}) {
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

  const formatBytes = (b?: number) => {
    if (!b || b <= 0) return "";
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
    if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
    return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  const dlPct =
    job.downloadProgress != null ? Math.round(job.downloadProgress * 100) : null;
  const upPct =
    job.uploadProgress != null ? Math.round(job.uploadProgress * 100) : null;
  const activePhase = job.phase;
  const isUploading = activePhase === "uploading";
  const isDownloading = activePhase === "downloading" || activePhase === "processing";

  const phaseText =
    job.status === "running"
      ? job.toDrive
        ? isUploading
          ? `Uploading to Drive${upPct != null ? ` · ${upPct}%` : "…"}`
          : isDownloading
            ? `Downloading${dlPct != null ? ` · ${dlPct}%` : "…"}`
            : "Preparing…"
        : "Fetching link…"
      : job.status === "done"
        ? "Complete"
        : job.status === "error"
          ? "Failed"
          : "Queued";

  const activePct = isUploading ? upPct : dlPct;
  const activeCurrent = isUploading ? job.uploadedBytes : job.downloadedBytes;
  const activeTotal = isUploading ? job.uploadTotalBytes : job.totalBytes;

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
          <div className="flex items-start justify-between gap-2">
            <div className="truncate text-sm font-medium">{job.url}</div>
            <StatusBadge job={job} />
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <span>{phaseText}</span>
            <span>•</span>
            <span>{elapsed}s</span>
            <span>•</span>
            <span>
              {job.toDrive ? "Drive" : "Direct"} · {job.mode} · {job.quality}
            </span>
            {job.toDrive && job.cookieDomain && (
              <>
                <span>•</span>
                <span>Cookie: {job.cookieDomain}</span>
              </>
            )}
            {job.status === "queued" && (job.attempts ?? 0) > 0 && (
              <>
                <span>•</span>
                <span>Retry {job.attempts}/{MAX_AUTO_RETRIES}</span>
              </>
            )}
          </div>


          {job.status === "running" && (
            <div className="mt-3 space-y-2">
              {job.toDrive && (dlPct != null || upPct != null) ? (
                <>
                  <div>
                    <div className="mb-1 flex justify-between text-[11px] text-muted-foreground">
                      <span>Download</span>
                      <span>
                        {dlPct != null ? `${dlPct}%` : "—"}
                        {job.totalBytes
                          ? ` · ${formatBytes(job.downloadedBytes)} / ${formatBytes(job.totalBytes)}`
                          : job.downloadedBytes
                            ? ` · ${formatBytes(job.downloadedBytes)}`
                            : ""}
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary transition-all duration-300"
                        style={{ width: `${dlPct ?? 0}%` }}
                      />
                    </div>
                  </div>
                  <div>
                    <div className="mb-1 flex justify-between text-[11px] text-muted-foreground">
                      <span>Upload to Drive</span>
                      <span>
                        {upPct != null ? `${upPct}%` : "—"}
                        {job.uploadTotalBytes
                          ? ` · ${formatBytes(job.uploadedBytes)} / ${formatBytes(job.uploadTotalBytes)}`
                          : ""}
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary transition-all duration-300"
                        style={{ width: `${upPct ?? 0}%` }}
                      />
                    </div>
                  </div>
                  {activePct == null && activeCurrent ? (
                    <div className="text-[11px] text-muted-foreground">
                      {formatBytes(activeCurrent)}
                      {activeTotal ? ` / ${formatBytes(activeTotal)}` : ""}
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full w-1/3 animate-[progress_1.4s_ease-in-out_infinite] rounded-full bg-primary" />
                </div>
              )}
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

          {job.status === "error" && (
            <div className="mt-2 flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1 text-xs text-destructive">
                {job.error || "Failed"}
              </div>
              <Button
                size="sm"
                onClick={onRetry}
                className="h-8 shrink-0 gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90"
              >
                <RotateCcw className="h-3.5 w-3.5" /> Retry
              </Button>
            </div>
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

function StatsDashboard({ jobs }: { jobs: Job[] }) {
  const total = jobs.length;
  const done = jobs.filter((j) => j.status === "done").length;
  const failed = jobs.filter((j) => j.status === "error").length;
  const queuedOrRunning = jobs.filter((j) => j.status === "queued" || j.status === "running").length;
  const successRate = total > 0 ? Math.round((done / total) * 100) : 0;

  const driveUploads = jobs.filter((j) => j.status === "done" && j.result?.kind === "success").length;
  const totalMb = jobs.reduce((sum, j) => {
    if (j.status === "done" && j.result?.kind === "success") {
      return sum + (j.result.sizeMb ?? 0);
    }
    return sum;
  }, 0);

  const avgDownloadSeconds =
    done > 0
      ? Math.round(
          jobs.reduce((sum, j) => {
            if (j.status === "done" && j.result?.kind === "success") {
              return sum + (j.result.downloadSeconds ?? 0);
            }
            return sum;
          }, 0) / done,
        )
      : 0;

  const domainCounts = jobs.reduce<Record<string, number>>((acc, j) => {
    try {
      const host = new URL(j.url).hostname.replace(/^www\./, "");
      acc[host] = (acc[host] ?? 0) + 1;
    } catch {
      // ignore invalid URLs
    }
    return acc;
  }, {});
  const topDomain = Object.entries(domainCounts).sort((a, b) => b[1] - a[1])[0]?.[0];

  const Stat = ({
    icon,
    label,
    value,
    sub,
  }: {
    icon: React.ReactNode;
    label: string;
    value: string;
    sub?: string;
  }) => (
    <div className="glass-card rounded-xl p-4">
      <div className="flex items-center gap-2 text-muted-foreground">
        {icon}
        <span className="text-xs font-medium">{label}</span>
      </div>
      <div className="mt-2 text-2xl font-semibold">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );

  return (
    <section className="mx-auto mt-10 max-w-3xl">
      <div className="mb-3 flex items-center gap-2 px-1">
        <BarChart3 className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-medium">Download analytics</h2>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          icon={<TrendingUp className="h-4 w-4" />}
          label="Success rate"
          value={`${successRate}%`}
          sub={`${done} done / ${total} total`}
        />
        <Stat
          icon={<CheckCircle2 className="h-4 w-4" />}
          label="Drive uploads"
          value={String(driveUploads)}
          sub={totalMb > 0 ? `${totalMb.toFixed(1)} MB uploaded` : undefined}
        />
        <Stat
          icon={<AlertCircle className="h-4 w-4" />}
          label="Failed / active"
          value={`${failed}${queuedOrRunning > 0 ? ` + ${queuedOrRunning}` : ""}`}
          sub={failed > 0 ? "Retry kora jabe" : undefined}
        />
        <Stat
          icon={<Clock className="h-4 w-4" />}
          label="Avg download time"
          value={avgDownloadSeconds > 0 ? `${avgDownloadSeconds}s` : "—"}
          sub={topDomain ? `Top: ${topDomain}` : undefined}
        />
      </div>
    </section>
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
