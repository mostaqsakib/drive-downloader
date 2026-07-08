import { createFileRoute } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import {
  Download,
  Loader2,
  ExternalLink,
  Sparkles,
  Youtube,
  Music2,
  Video,
  ShieldCheck,
  Link2,
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
import { fetchDownload, type CobaltResult } from "@/lib/downloader.functions";

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

function Home() {
  const runFn = useServerFn(fetchDownload);

  const [url, setUrl] = useState("");
  const [mode, setMode] = useState<(typeof MODE_OPTIONS)[number]["value"]>("auto");
  const [quality, setQuality] = useState<(typeof QUALITY_OPTIONS)[number]["value"]>("1080");
  const [result, setResult] = useState<CobaltResult | null>(null);

  const mutation = useMutation({
    mutationFn: () => runFn({ data: { url: url.trim(), mode, quality } }),
    onSuccess: (r) => {
      setResult(r);
      if (r.kind === "tunnel" || r.kind === "redirect") {
        toast.success("Ready!", { description: "Download link ready — niche click koren." });
        window.open(r.url, "_blank", "noopener,noreferrer");
      } else if (r.kind === "picker") {
        toast.success(`${r.items.length} ta item paoa gelo`);
      } else if (r.kind === "error") {
        toast.error(r.message);
      }
    },
    onError: (err: Error) => toast.error(err.message ?? "Kichu ekta bhul holo"),
  });

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
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <ShieldCheck className="h-4 w-4 text-primary" />
          No ads • No signup
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 pb-24">
        <section className="pt-8 md:pt-14">
          <div className="mx-auto max-w-3xl text-center">
            <Badge
              variant="secondary"
              className="mb-4 border border-primary/30 bg-primary/10 text-primary"
            >
              <Sparkles className="mr-1 h-3 w-3" /> 30+ sites supported
            </Badge>
            <h1 className="text-4xl font-bold leading-tight md:text-6xl">
              Paste a link. <span className="text-gradient">Get the file.</span>
            </h1>
            <p className="mx-auto mt-4 max-w-xl text-base text-muted-foreground md:text-lg">
              Fast, clean, no-nonsense downloader for YouTube, TikTok, Instagram, Twitter/X,
              Reddit, Vimeo, SoundCloud and more.
            </p>
          </div>

          <div className="glass-card mx-auto mt-10 max-w-3xl rounded-2xl p-4 md:p-6">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!url.trim()) return toast.error("Ekta URL diben");
                setResult(null);
                mutation.mutate();
              }}
              className="flex flex-col gap-3"
            >
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
                <Select value={mode} onValueChange={(v) => setMode(v as typeof mode)}>
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
                  onValueChange={(v) => setQuality(v as typeof quality)}
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
                  disabled={mutation.isPending}
                  className="h-12 gap-2 bg-primary text-primary-foreground hover:bg-primary/90 md:w-48"
                >
                  {mutation.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" /> Fetching…
                    </>
                  ) : (
                    <>
                      <Download className="h-4 w-4" /> Download
                    </>
                  )}
                </Button>
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

          {result && result.kind !== "error" && (
            <div className="mx-auto mt-6 max-w-3xl">
              {(result.kind === "tunnel" || result.kind === "redirect") && (
                <a href={result.url} target="_blank" rel="noopener noreferrer">
                  <div className="glass-card flex items-center justify-between rounded-xl p-4 transition hover:border-primary/60">
                    <div className="min-w-0">
                      <div className="text-sm font-medium">Download ready</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {result.filename ?? result.url}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      className="gap-1.5 bg-accent text-accent-foreground hover:bg-accent/90"
                    >
                      <ExternalLink className="h-3.5 w-3.5" /> Open
                    </Button>
                  </div>
                </a>
              )}

              {result.kind === "picker" && (
                <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                  {result.items.map((it, i) => (
                    <a
                      key={i}
                      href={it.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="glass-card group overflow-hidden rounded-xl transition hover:border-primary/60"
                    >
                      {it.thumb ? (
                        <img
                          src={it.thumb}
                          alt={`item ${i + 1}`}
                          className="aspect-square w-full object-cover"
                        />
                      ) : (
                        <div className="grid aspect-square w-full place-items-center bg-muted">
                          <Video className="h-8 w-8 text-muted-foreground" />
                        </div>
                      )}
                      <div className="flex items-center justify-between p-3 text-xs">
                        <span>Item {i + 1}</span>
                        <ExternalLink className="h-3.5 w-3.5 opacity-60 group-hover:opacity-100" />
                      </div>
                    </a>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>

        <section className="mt-20 grid gap-4 md:grid-cols-3">
          <FeatureCard
            title="Instant"
            body="No queue, no processing wait — direct link theke bhaba jayna eto fast."
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
