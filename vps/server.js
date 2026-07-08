// DriveGrabber VPS worker: yt-dlp downloader + rclone uploader to Google Drive.
// Run behind Nginx + Certbot (HTTPS), started as a systemd service.
//
// Env vars (see /etc/rexovaan/env):
//   API_TOKEN         - shared secret; must match Lovable's VPS_API_TOKEN
//   PORT              - default 8787
//   DOWNLOAD_DIR      - default /var/lib/drivegrabber/downloads
//   DB_PATH           - default /var/lib/drivegrabber/jobs.db
//   RCLONE_REMOTE     - default gdrive
//   RCLONE_DEST       - default DriveGrabber
//   CONCURRENCY       - default 2
//   YTDLP_BIN         - default yt-dlp
//   RCLONE_BIN        - default rclone
//   COOKIES_FILE      - optional path to yt-dlp cookies.txt (Instagram/etc)

import express from "express";
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, existsSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";

const {
  API_TOKEN,
  PORT = "8787",
  DOWNLOAD_DIR = "/var/lib/drivegrabber/downloads",
  DB_PATH = "/var/lib/drivegrabber/jobs.db",
  RCLONE_REMOTE = "gdrive",
  RCLONE_DEST = "DriveGrabber",
  CONCURRENCY = "2",
  YTDLP_BIN = "yt-dlp",
  RCLONE_BIN = "rclone",
  COOKIES_FILE,
} = process.env;

if (!API_TOKEN || API_TOKEN.length < 16) {
  console.error("FATAL: API_TOKEN env var missing or too short (>=16 chars)");
  process.exit(1);
}

mkdirSync(DOWNLOAD_DIR, { recursive: true });
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    quality TEXT NOT NULL,
    status TEXT NOT NULL,
    title TEXT,
    filename TEXT,
    driveLink TEXT,
    error TEXT,
    progress REAL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
`);

const insertStmt = db.prepare(
  `INSERT INTO jobs (id,url,quality,status,createdAt,updatedAt) VALUES (?,?,?,?,?,?)`,
);
const updateStmt = db.prepare(
  `UPDATE jobs SET status=?, title=COALESCE(?,title), filename=COALESCE(?,filename),
     driveLink=COALESCE(?,driveLink), error=?, progress=?, updatedAt=? WHERE id=?`,
);
const getStmt = db.prepare(`SELECT * FROM jobs WHERE id=?`);
const listStmt = db.prepare(`SELECT * FROM jobs ORDER BY createdAt DESC LIMIT 100`);
const delStmt = db.prepare(`DELETE FROM jobs WHERE id=?`);

function updateJob(id, patch) {
  const cur = getStmt.get(id);
  if (!cur) return;
  const merged = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  updateStmt.run(
    merged.status,
    patch.title ?? null,
    patch.filename ?? null,
    patch.driveLink ?? null,
    merged.error ?? null,
    merged.progress ?? null,
    merged.updatedAt,
    id,
  );
}

// ---- Queue --------------------------------------------------------------
const queue = [];
let running = 0;
const maxConcurrent = Math.max(1, parseInt(CONCURRENCY, 10) || 2);

function enqueue(id) {
  queue.push(id);
  drain();
}
function drain() {
  while (running < maxConcurrent && queue.length) {
    const id = queue.shift();
    running++;
    processJob(id)
      .catch((e) => {
        console.error("job crash", id, e);
        updateJob(id, { status: "failed", error: String(e?.message || e) });
      })
      .finally(() => {
        running--;
        drain();
      });
  }
}

function qualityToYtdlpArgs(q) {
  switch (q) {
    case "audio":
      return ["-x", "--audio-format", "mp3", "--audio-quality", "0"];
    case "1080p":
      return ["-f", "bv*[height<=1080]+ba/b[height<=1080]", "--merge-output-format", "mp4"];
    case "720p":
      return ["-f", "bv*[height<=720]+ba/b[height<=720]", "--merge-output-format", "mp4"];
    case "480p":
      return ["-f", "bv*[height<=480]+ba/b[height<=480]", "--merge-output-format", "mp4"];
    case "best":
    default:
      return ["-f", "bv*+ba/b", "--merge-output-format", "mp4"];
  }
}

async function processJob(id) {
  const job = getStmt.get(id);
  if (!job) return;
  const workDir = join(DOWNLOAD_DIR, id);
  mkdirSync(workDir, { recursive: true });
  updateJob(id, { status: "downloading", progress: 0 });

  // 1. yt-dlp
  const args = [
    ...qualityToYtdlpArgs(job.quality),
    "--no-playlist",
    "--restrict-filenames",
    "--newline",
    "--progress",
    "-o",
    "%(title).200B [%(id)s].%(ext)s",
    job.url,
  ];
  if (COOKIES_FILE && existsSync(COOKIES_FILE)) {
    args.push("--cookies", COOKIES_FILE);
  }

  let lastTitle;
  await runProc(YTDLP_BIN, args, { cwd: workDir }, (line) => {
    // Parse progress: "[download]   4.2% of  ..."
    const m = /\[download\]\s+([\d.]+)%/i.exec(line);
    if (m) updateJob(id, { status: "downloading", progress: parseFloat(m[1]) });
    const t = /\[info\]\s+.*?:\s*Downloading.*?:\s*(.+)/i.exec(line);
    if (t) lastTitle = t[1];
  });

  const files = readdirSync(workDir)
    .filter((f) => !f.endsWith(".part") && !f.endsWith(".ytdl"))
    .map((f) => ({ name: f, size: statSync(join(workDir, f)).size }))
    .sort((a, b) => b.size - a.size);
  if (!files.length) throw new Error("yt-dlp finished but no output file found");
  const fileName = files[0].name;

  updateJob(id, {
    status: "uploading",
    progress: 100,
    filename: fileName,
    title: lastTitle || fileName,
  });

  // 2. rclone upload
  const remotePath = `${RCLONE_REMOTE}:${RCLONE_DEST}/${fileName}`;
  await runProc(
    RCLONE_BIN,
    ["copyto", join(workDir, fileName), remotePath, "--drive-chunk-size=64M", "-v"],
    {},
  );

  // 3. get Drive link
  let driveLink = "";
  try {
    const linkOut = await captureProc(RCLONE_BIN, ["link", remotePath]);
    driveLink = linkOut.trim().split("\n").pop() || "";
  } catch (e) {
    console.warn("rclone link failed", e);
  }

  updateJob(id, { status: "done", driveLink });

  // cleanup local file
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {}
}

function runProc(cmd, args, opts, onLine) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    const handle = (buf) => {
      const s = buf.toString();
      for (const line of s.split(/\r?\n/)) {
        if (line && onLine) onLine(line);
      }
    };
    p.stdout.on("data", handle);
    p.stderr.on("data", handle);
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

function captureProc(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let out = "";
    let err = "";
    p.stdout.on("data", (b) => (out += b.toString()));
    p.stderr.on("data", (b) => (err += b.toString()));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err || `exit ${code}`))));
  });
}

// ---- HTTP ---------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "64kb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use((req, res, next) => {
  if (req.path === "/health") return next();
  const auth = req.header("authorization") || "";
  const tok = auth.replace(/^Bearer\s+/i, "");
  if (tok !== API_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true, queued: queue.length, running }));

app.post("/jobs", (req, res) => {
  const { url, quality = "best" } = req.body || {};
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: "Invalid url" });
  }
  if (!["best", "1080p", "720p", "480p", "audio"].includes(quality)) {
    return res.status(400).json({ error: "Invalid quality" });
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  insertStmt.run(id, url, quality, "queued", now, now);
  enqueue(id);
  res.json(getStmt.get(id));
});

app.get("/jobs", (_req, res) => res.json({ jobs: listStmt.all() }));
app.get("/jobs/:id", (req, res) => {
  const j = getStmt.get(req.params.id);
  if (!j) return res.status(404).json({ error: "not found" });
  res.json(j);
});
app.delete("/jobs/:id", (req, res) => {
  const j = getStmt.get(req.params.id);
  if (!j) return res.status(404).json({ error: "not found" });
  delStmt.run(req.params.id);
  try {
    rmSync(join(DOWNLOAD_DIR, req.params.id), { recursive: true, force: true });
  } catch {}
  res.json({ ok: true });
});

const port = parseInt(PORT, 10);
app.listen(port, "0.0.0.0", () => {
  console.log(`DriveGrabber VPS listening on :${port} (concurrency=${maxConcurrent})`);
});
