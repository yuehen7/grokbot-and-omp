#!/usr/bin/env node
// omp-task.mjs — tracked, resumable OMP tasks on top of `omp --mode rpc`.
//
// Each task lives in $OMP_TASK_DIR (default ~/.omp/tasks)/<id>/ and keeps
// status.json, events.jsonl, prompt-<n>.txt and result.md. See
// docs/omp-task-reference.md. Node 22+, no third-party dependencies.

import { spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  appendFileSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TASK_ROOT = resolve(process.env.OMP_TASK_DIR || join(homedir(), ".omp", "tasks"));
const SESSION_DIR =
  process.env.OMP_TASK_SESSION_DIR || join(homedir(), ".omp", "agent", "sessions", "tasks");
const OMP_BIN = process.env.OMP_BIN || "omp";

const DEFAULT_MODEL = process.env.OMP_TASK_MODEL || null;
const DEFAULT_THINKING = process.env.OMP_TASK_THINKING || "medium";
const DEFAULT_NOTIFY_PREFIX = process.env.OMP_TASK_NOTIFY_PREFIX || null;
const DEFAULT_TIMEOUT = 300; // seconds, same default as omp-call.mjs
const DEFAULT_IDLE_TIMEOUT = 300; // seconds, idle timeout for no RPC events
const EVENT_TEXT_MAX = 500;
const TERMINAL = new Set(["done", "failed", "cancelled", "interrupted"]);
const EXIT = { done: 0, failed: 1, timeout: 124, cancelled: 130 };

// OMP's tool catalog is different from Pi's. These sets mirror the GAP intent:
// read-only tools when --no-write, plus a shell/edit/write set otherwise.
// `eval` and `task` are deliberately excluded: eval bypasses the bash guard and
// subagents would run outside this task's guard/approval loop.
const READ_TOOLS = ["read", "glob", "grep"];
const WRITE_TOOLS = ["read", "bash", "edit", "write", "glob", "grep", "todo", "wait"];
const WEB_TOOL = "web_search";

// ---------------------------------------------------------------- utilities

const iso = () => new Date().toISOString();
// Display in the host's local timezone; store timestamps as ISO UTC.
const lt = (v) => { if (!v) return "-"; const d = new Date(v); if (isNaN(d)) return String(v); const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
const pad = (n, w = 2) => String(n).padStart(w, "0");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stamp(d = new Date()) {
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function cleanSession(name) {
  const s = String(name ?? "")
    .replace(/[\\/\s]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  if (!s) throw usageError("invalid session name");
  return s;
}

function validTaskId(id) {
  return typeof id === "string" && /^[^.][^\\/]*$/.test(id) && !id.includes("..");
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function humanAge(isoStr) {
  if (!isoStr) return "-";
  const ms = Date.now() - Date.parse(isoStr);
  if (!Number.isFinite(ms)) return "-";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${pad(m % 60)}m`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

function humanDuration(startIso, endIso) {
  if (!startIso) return "-";
  const end = endIso ? Date.parse(endIso) : Date.now();
  const ms = end - Date.parse(startIso);
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m${pad(rs)}s`;
  return `${Math.floor(m / 60)}h${pad(m % 60)}m`;
}

function shortText(value, max = EVENT_TEXT_MAX) {
  if (value === undefined || value === null || value === "") return undefined;
  let s = typeof value === "string" ? value : JSON.stringify(value);
  if (!s) return undefined;
  // events.jsonl stays one line per record and free of huge payloads
  s = s.replace(/[\r\n\u2028\u2029\t]+/g, " ⏎ ").trim();
  if (!s) return undefined;
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function usageError(msg) {
  process.stderr.write(`omp-task: ${msg}\n\n${USAGE}`);
  process.exit(2);
}

function fail(msg, code = 1) {
  process.stderr.write(`omp-task: ${msg}\n`);
  process.exit(code);
}

// `process.exit()` can truncate pending pipe writes; wait for stdout/stderr
// to drain before leaving so callers piping our output see every line.
function flushAndExit(code) {
  let left = 2;
  const done = () => {
    if (--left === 0) process.exit(code);
  };
  setTimeout(() => process.exit(code), 2000);
  for (const stream of [process.stdout, process.stderr]) {
    try {
      stream.write("", done);
    } catch {
      done();
    }
  }
}

process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

// --------------------------------------------------------------- task store

const taskDir = (id) => join(TASK_ROOT, id);
const statusPath = (id) => join(taskDir(id), "status.json");

function writeStatus(id, status) {
  const dir = taskDir(id);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.status.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(status, null, 2)}\n`);
  renameSync(tmp, statusPath(id)); // atomic replace
}

function readStatus(id) {
  if (!validTaskId(id)) fail(`invalid task id: ${id}`);
  let raw;
  try {
    raw = readFileSync(statusPath(id), "utf8");
  } catch {
    fail(`task not found: ${id}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    fail(`corrupt status.json for task: ${id}`);
  }
}

function appendEvent(dir, type, tool, text) {
  const rec = { ts: iso(), type };
  if (tool) rec.tool = String(tool);
  const t = shortText(text);
  if (t) rec.text = t;
  try {
    appendFileSync(join(dir, "events.jsonl"), `${JSON.stringify(rec)}\n`);
  } catch {
    // never let logging break the run
  }
}

function readEvents(dir, limit) {
  let raw;
  try {
    raw = readFileSync(join(dir, "events.jsonl"), "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  const picked = limit ? lines.slice(-limit) : lines;
  return picked
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function fmtEvent(rec, max = 120) {
  const t = lt(rec.ts);
  let line = `${t}  ${rec.type || "?"}`;
  if (rec.tool) line += ` ${rec.tool}`;
  if (rec.text) {
    const text = rec.text.length > max ? `${rec.text.slice(0, max)}…` : rec.text;
    line += `  ${text}`;
  }
  return line;
}

function writeResult(dir, text) {
  const body = text.endsWith("\n") ? text : `${text}\n`;
  writeFileSync(join(dir, "result.md"), body);
}

function listTaskIds() {
  let entries;
  try {
    entries = readdirSync(TASK_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

// Every subcommand starts here: a task still marked running whose process is
// gone becomes interrupted, otherwise it would look busy forever.
function orphanCheck() {
  let changed = 0;
  for (const id of listTaskIds()) {
    let status;
    try {
      status = JSON.parse(readFileSync(statusPath(id), "utf8"));
    } catch {
      continue;
    }
    if (status?.state !== "running" && status?.state !== "queued") continue;
    if (status.state === "running" && status.pid && isAlive(status.pid)) continue;
    // A queued record is only stale once its owner had time to start it.
    if (status.state === "queued" && Date.now() - Date.parse(status.created_at || 0) < 60000) {
      continue;
    }
    const end = iso();
    status.state = "interrupted";
    status.ended_at = end;
    status.error = status.error || "orphaned: process no longer running";
    status.pid = null;
    const last = Array.isArray(status.runs) && status.runs.length
      ? status.runs[status.runs.length - 1]
      : null;
    if (last && !last.ended_at) last.ended_at = end;
    try {
      writeStatus(id, status);
      appendEvent(taskDir(id), "orphan_detected", undefined, "state=interrupted");
      changed++;
    } catch {
      // ignore unreadable/unwritable task dirs
    }
  }
  return changed;
}

function assertSessionFree(session, ignoreId) {
  for (const id of listTaskIds()) {
    if (id === ignoreId) continue;
    let status;
    try {
      status = JSON.parse(readFileSync(statusPath(id), "utf8"));
    } catch {
      continue;
    }
    // Treat queued as occupied too: otherwise two parallel `run`s can both pass
    // while the other is still writing its queued status (TOCTOU).
    if (
      (status?.state === "running" || status?.state === "queued") &&
      status.session === session
    ) {
      fail(`session "${session}" is already in use by ${status.state} task ${status.id}`);
    }
  }
}

function isExecutable(p) {
  try {
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Prefer an on-disk session file; fall back to OMP session id (--resume accepts both). */
function resolveResumeTarget(status) {
  if (status?.session_file && existsSync(status.session_file)) {
    return { kind: "file", value: status.session_file };
  }
  if (typeof status?.omp_session_id === "string" && status.omp_session_id.trim()) {
    return { kind: "id", value: status.omp_session_id.trim() };
  }
  return null;
}

// --------------------------------------------------------- omp invocation

function findGuardExtensionPath() {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = dirname(currentFile);
  // 1. workspace layout: bin/../extensions/omp-guard.ts
  const p1 = resolve(currentDir, "..", "extensions", "omp-guard.ts");
  if (existsSync(p1)) return p1;
  // 2. installed layout: TARGET_DIR/extensions/omp-guard.ts
  const p2 = resolve(currentDir, "extensions", "omp-guard.ts");
  if (existsSync(p2)) return p2;
  return null;
}

function findPreflightPath() {
  if (process.env.OMP_TASK_PREFLIGHT) {
    const p = process.env.OMP_TASK_PREFLIGHT;
    if (existsSync(p) && isExecutable(p)) return p;
    return null;
  }
  const currentDir = dirname(fileURLToPath(import.meta.url));
  for (const p of [resolve(currentDir, "omp-preflight"), resolve(currentDir, "..", "bin", "omp-preflight")]) {
    if (existsSync(p) && isExecutable(p)) return p;
  }
  return null;
}

function runPreflight(dir) {
  const pf = findPreflightPath();
  if (!pf) {
    if (process.env.OMP_TASK_PREFLIGHT) {
      appendEvent(dir, "preflight", undefined, `skipped: not executable ${process.env.OMP_TASK_PREFLIGHT}`);
    }
    return;
  }
  appendEvent(dir, "preflight", undefined, "started");
  try {
    // Keep stderr visible so Tailscale/reconnect diagnostics reach the operator.
    const r = spawnSync(pf, [], { stdio: ["ignore", "ignore", "inherit"], timeout: 180000 });
    if (r.error) {
      appendEvent(dir, "preflight", undefined, `error ${r.error.message}`);
    } else {
      appendEvent(dir, "preflight", undefined, r.status === 0 ? "ok" : `exit ${r.status}`);
    }
  } catch (e) {
    appendEvent(dir, "preflight", undefined, `spawn failed: ${e?.message || e}`);
  }
}

function runPreflightAsync(dir, why) {
  const pf = findPreflightPath();
  if (!pf) return;
  try {
    const c = spawn(pf, [], { stdio: ["ignore", "ignore", "inherit"] });
    c.on("exit", (code) => appendEvent(dir, "preflight", undefined, code === 0 ? "ok" : `exit ${code}`));
    c.on("error", (e) => appendEvent(dir, "preflight", undefined, `spawn failed: ${e.message}`));
    appendEvent(dir, "preflight", undefined, `started after connection error (${why})`);
  } catch (e) {
    appendEvent(dir, "preflight", undefined, `spawn failed: ${e?.message || e}`);
  }
}

function toolsFor(write, web) {
  const base = write ? WRITE_TOOLS : READ_TOOLS;
  const tools = [...base];
  if (web) tools.push(WEB_TOOL);
  return tools.join(",");
}

function ompArgs(status, resumeTarget) {
  const opts = status.options && typeof status.options === "object" ? status.options : {};
  const model = status.model || DEFAULT_MODEL;
  const thinking = opts.thinking || DEFAULT_THINKING;
  const allowWrite = opts.write !== false;
  const allowWeb = opts.web !== false;
  const guardDisabled = process.env.OMP_GUARD === "off" || opts.guard === "off";

  const args = ["--mode", "rpc"];
  if (resumeTarget) {
    // --resume accepts a session file path or an id/prefix (OMP CLI).
    args.push("--resume", resumeTarget.value);
    if (resumeTarget.kind === "id") {
      // Keep lookups scoped to the task session store when resuming by id.
      args.push("--session-dir", SESSION_DIR);
    }
  } else {
    args.push("--session-dir", SESSION_DIR);
  }
  if (model) args.push("--model", String(model));
  if (thinking) args.push("--thinking", String(thinking));
  args.push("--tools", toolsFor(allowWrite, allowWeb));
  // These hosts are non-interactive; OMP's own tool prompt must not hang.
  // This is NOT Bot-side approve/deny: omp-guard still blocks disasters.
  args.push("--auto-approve");
  if (!guardDisabled) {
    const guardPath = findGuardExtensionPath();
    if (guardPath) args.push("-e", guardPath);
  }
  return args;
}

function toolSummary(args) {
  if (!args || typeof args !== "object") return undefined;
  if (typeof args.command === "string") return args.command;
  if (typeof args.path === "string") return args.path;
  if (typeof args.pattern === "string") return args.pattern;
  if (typeof args.query === "string") return args.query;
  if (Array.isArray(args.queries)) return args.queries.join(" | ");
  if (typeof args.url === "string") return args.url;
  if (Array.isArray(args.urls)) return args.urls.join(" ");
  const s = JSON.stringify(args);
  return s === "{}" ? undefined : s;
}

function textOf(message) {
  if (!message) return "";
  if (Array.isArray(message.content)) {
    return message.content
      .filter((c) => c && c.type === "text")
      .map((c) => c.text || "")
      .join("");
  }
  return typeof message.content === "string" ? message.content : "";
}

function getNotifyConfig(prefix) {
  const p = prefix || process.env.OMP_TASK_NOTIFY_PREFIX || null;
  if (p) {
    const url = process.env[`${p}_OMP_NOTIFY_URL`] || process.env[`${p.toUpperCase()}_OMP_NOTIFY_URL`];
    const key = process.env[`${p}_OMP_NOTIFY_KEY`] || process.env[`${p.toUpperCase()}_OMP_NOTIFY_KEY`];
    return { url, key };
  }
  return {
    url: process.env.OMP_NOTIFY_URL,
    key: process.env.OMP_NOTIFY_SECRET,
  };
}

// Notify the Bot on completion: POST {source,id,owner,state,exit_code} to webhook URL.
// A detached notifier receives the Bearer secret via environment, not argv; skip if unconfigured.
function notify(dir, id, owner, state, code, notifyPrefix, extra = {}) {
  const { url, key } = getNotifyConfig(notifyPrefix);
  if (!url || !key || process.env.OMP_NOTIFY_OFF) return;
  const payload = {
    source: "omp-task",
    id,
    owner: owner ?? null,
    state,
    exit_code: code,
    ...extra,
  };
  const js = `const [u,b,f]=process.argv.slice(1);const fs=require("fs");
fetch(u,{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+process.env.__OMP_NOTIFY_SECRET},body:b,signal:AbortSignal.timeout(15000)})
.then(r=>fs.appendFileSync(f,JSON.stringify({ts:new Date().toISOString(),type:"notify",text:"http "+r.status})+"\\n"))
.catch(e=>fs.appendFileSync(f,JSON.stringify({ts:new Date().toISOString(),type:"notify",text:"error "+String(e.message||e).slice(0,200)})+"\\n"));`;
  try {
    const notifyEnv = { ...process.env, __OMP_NOTIFY_SECRET: key };
    const c = spawn(process.execPath, ["-e", js, url, JSON.stringify(payload), join(dir, "events.jsonl")],
      { detached: true, stdio: "ignore", env: notifyEnv });
    c.unref();
  } catch { /* Notification failure does not affect results; pending provides recovery. */ }
}

// ------------------------------------------------------------- RPC reader

// OMP protocol v2 splits oversized frames into `rpc_chunk` records. Reassemble
// them before JSON semantics; validate sequence/count/length like OMP does.
function createFrameAssembler() {
  let state = null;
  return function push(rec) {
    if (!rec || rec.type !== "rpc_chunk") {
      if (state) {
        state = null;
        throw new Error("rpc chunk sequence interrupted");
      }
      return rec;
    }
    const { chunkId, index, count, byteLength, data } = rec;
    if (
      typeof chunkId !== "string" || chunkId.length === 0 || chunkId.length > 128 ||
      !Number.isSafeInteger(index) || !Number.isSafeInteger(count) ||
      !Number.isSafeInteger(byteLength) ||
      index < 0 || count < 2 || index >= count || byteLength < 0 ||
      typeof data !== "string"
    ) {
      throw new Error("invalid rpc chunk metadata");
    }
    let bytes;
    try {
      bytes = Buffer.from(data, "base64");
    } catch {
      throw new Error("invalid rpc chunk data");
    }
    if (!state) {
      if (index !== 0) throw new Error("rpc chunk sequence must start at index 0");
      state = { chunkId, count, byteLength, nextIndex: 0, chunks: [], receivedBytes: 0 };
    }
    if (
      state.chunkId !== chunkId || state.count !== count ||
      state.byteLength !== byteLength || state.nextIndex !== index
    ) {
      throw new Error("rpc chunk sequence mismatch");
    }
    state.chunks.push(bytes);
    state.receivedBytes += bytes.byteLength;
    state.nextIndex++;
    if (state.receivedBytes > state.byteLength) {
      throw new Error("rpc chunk sequence exceeds declared length");
    }
    if (state.nextIndex < state.count) return null;
    if (state.receivedBytes !== state.byteLength) {
      throw new Error("rpc chunk sequence length mismatch");
    }
    const text = Buffer.concat(state.chunks).toString("utf8");
    state = null;
    const frame = JSON.parse(text);
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
      throw new Error("rpc frame must be an object");
    }
    return frame;
  };
}

const INTERACTIVE_UI = new Set(["select", "confirm", "input", "editor", "ask"]);

// Run one prompt turn inside a task, stream events, update status, exit.
function execute(id, prompt, timeoutSec, idleTimeoutSec) {
  const dir = taskDir(id);
  let status = readStatus(id);
  const runs = Array.isArray(status.runs) ? status.runs : [];
  const n = runs.length + 1;
  const startedAt = iso();

  // n === 1 is the first turn; later turns (reply/approve/deny) must resume.
  const requireResume = n > 1;
  if (status.session_file && !existsSync(status.session_file)) {
    appendEvent(dir, "session_missing", undefined, status.session_file);
  }
  const resumeTarget = resolveResumeTarget(status);
  // Fail before flipping state to running / appending a run, so a missing
  // session cannot leave the task stuck as running with a dead pid.
  if (requireResume && !resumeTarget) {
    fail(
      `task ${id} has no resumable OMP session (missing usable session_file and omp_session_id); ` +
        "refusing to start a cold session that would lose context",
    );
  }

  writeFileSync(join(dir, `prompt-${n}.txt`), prompt.endsWith("\n") ? prompt : `${prompt}\n`);
  runs.push({ n, prompt, started_at: startedAt, ended_at: null, exit_code: null });
  status.runs = runs;
  status.state = "running";
  status.pid = process.pid;
  if (!status.started_at) status.started_at = startedAt; // first run wins
  status.ended_at = null;
  status.exit_code = null;
  status.error = null;
  writeStatus(id, status);

  // Preflight runs before OMP is spawned. The wrapper exports
  // OMP_TASK_PREFLIGHT when bin/omp-preflight exists beside the entry point.
  runPreflight(dir);
  appendEvent(dir, "task_start", undefined, prompt);
  if (resumeTarget) {
    appendEvent(
      dir,
      "session_resume",
      undefined,
      `${resumeTarget.kind}=${resumeTarget.value}`,
    );
  }

  const opts = status.options && typeof status.options === "object" ? status.options : {};
  const guardDisabled = process.env.OMP_GUARD === "off" || opts.guard === "off";

  try {
    mkdirSync(SESSION_DIR, { recursive: true });
  } catch {
    // OMP reports the real error below.
  }

  if (!guardDisabled && !findGuardExtensionPath()) {
    appendEvent(dir, "guard_missing", undefined, "omp-guard.ts not found; running without guard");
    process.stderr.write("omp-task: warning: omp-guard.ts not found; running without disaster protection\n");
  }

  const args = ompArgs(status, resumeTarget);

  // Remove notification URL/secret from OMP's environment. Provider credentials
  // are deliberately kept: OMP needs them to reach the model.
  const ompEnv = { ...process.env };
  delete ompEnv.OMP_NOTIFY_URL;
  delete ompEnv.OMP_NOTIFY_SECRET;
  delete ompEnv.__OMP_NOTIFY_SECRET;
  for (const k of Object.keys(ompEnv)) {
    if (k.endsWith("_OMP_NOTIFY_URL") || k.endsWith("_OMP_NOTIFY_KEY")) {
      delete ompEnv[k];
    }
  }
  ompEnv.OMP_TASK_DIR_CURRENT = dir;
  if (guardDisabled) ompEnv.OMP_GUARD = "off";

  const child = spawn(OMP_BIN, args, {
    cwd: status.cwd,
    env: ompEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const send = (obj) => {
    try {
      child.stdin.write(`${JSON.stringify(obj)}\n`);
    } catch {
      // child already gone; exit handler reports it
    }
  };

  let lastText = "";
  let lastError = "";
  let stderrBuf = "";
  let finished = false;
  let aborting = false;
  let timedOut = false;
  let idleTimedOut = false;
  let timeoutTimer = null;
  let idleTimer = null;
  let graceTimer = null;
  let fallbackTimer = null;
  let negotiateTimer = null;
  let startedPrompt = false;
  let promptResult = null;
  let sessionInfoRequested = false;
  let localPrompt = false; // slash/local handling: agentInvoked=false
  const promptId = `p${n}`;
  const stateId = `state${n}`;
  const negotiateId = `neg${n}`;

  const abort = () => {
    appendEvent(dir, "abort_sent", undefined, timedOut ? "timeout" : idleTimedOut ? "idle_timeout" : "signal");
    send({ type: "abort" });
  };

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (finished) return;
    if (idleTimeoutSec && idleTimeoutSec > 0) {
      idleTimer = setTimeout(() => {
        if (finished) return;
        idleTimedOut = true;
        lastError = "idle timeout";
        appendEvent(dir, "idle_timeout", undefined, `${idleTimeoutSec}s`);
        abort();
        graceTimer = setTimeout(() => finish(EXIT.failed), 5000);
      }, idleTimeoutSec * 1000);
    }
  };

  // Only requests written during this run are "new". Seeding with existing
  // records avoids re-sending needs_approval for an already-requested (and
  // possibly already approved/denied) command when reply/approve/deny resumes.
  const notifiedApprovals = new Set();
  try {
    const approvalsPath = join(dir, "approvals.jsonl");
    if (existsSync(approvalsPath)) {
      for (const line of readFileSync(approvalsPath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const item = JSON.parse(line);
          if (item?.req) notifiedApprovals.add(item.req);
        } catch {}
      }
    }
  } catch {}
  function checkApprovals() {
    const approvalsPath = join(dir, "approvals.jsonl");
    if (!existsSync(approvalsPath)) return;
    try {
      const content = readFileSync(approvalsPath, "utf8");
      const lines = content.split("\n").filter((l) => l.trim());
      for (const line of lines) {
        try {
          const item = JSON.parse(line);
          if (item && item.req && !notifiedApprovals.has(item.req)) {
            notifiedApprovals.add(item.req);
            appendEvent(dir, "approval_requested", undefined, `req=${item.req} cmd=${item.command}`);
            const notifyPrefix = status.notify_prefix ?? null;
            notify(dir, id, status.owner ?? null, "needs_approval", null, notifyPrefix, {
              req: item.req,
              command: item.command,
            });
          }
        } catch {}
      }
    } catch {}
  }
  const approvalTimer = setInterval(checkApprovals, 200);

  function stateFromCode(code) {
    if (code === EXIT.done) return "done";
    if (code === EXIT.cancelled) return "cancelled";
    return "failed";
  }

  function finish(code) {
    if (finished) return;
    finished = true;
    clearTimeout(timeoutTimer);
    clearTimeout(idleTimer);
    clearTimeout(graceTimer);
    clearTimeout(fallbackTimer);
    clearTimeout(negotiateTimer);
    clearInterval(approvalTimer);
    checkApprovals();

    const end = iso();
    let st = null;
    try {
      st = JSON.parse(readFileSync(statusPath(id), "utf8"));
    } catch {
      st = null;
    }
    const state = stateFromCode(code);
    if (st) {
      st.state = state;
      st.ended_at = end;
      st.exit_code = code;
      st.pid = null;
      if (code === EXIT.timeout) st.error = "timeout";
      else if (idleTimedOut) st.error = "idle timeout";
      else if (code === EXIT.done || code === EXIT.cancelled) st.error = null;
      else st.error = lastError || st.error || "failed";
      const last = Array.isArray(st.runs) && st.runs.length
        ? st.runs[st.runs.length - 1]
        : null;
      if (last) {
        last.ended_at = end;
        last.exit_code = code;
      }
      try {
        writeStatus(id, st);
      } catch {
        // status write failure must not mask the exit code
      }
    }
    if (lastText) {
      try {
        writeResult(dir, lastText);
      } catch {
        // ignore
      }
    }
    appendEvent(dir, "task_end", undefined, `state=${state} exit=${code}`);
    const notifyPrefix = st?.notify_prefix ?? status.notify_prefix ?? null;
    notify(dir, id, st ? st.owner ?? null : status.owner ?? null, state, code, notifyPrefix);
    const out = `STATE ${state}\nRESULT ${join(dir, "result.md")}\n`;
    process.stdout.write(out);
    if (code !== EXIT.done) {
      const why =
        code === EXIT.cancelled
          ? "cancelled"
          : code === EXIT.timeout
            ? "timeout"
            : idleTimedOut
              ? "idle timeout"
              : st?.error || lastError || stderrBuf.trim() || "failed";
      process.stderr.write(`omp-task: ${why}\n`);
    }

    // Orderly shutdown: EOF on stdin, then a grace kill in case OMP hangs.
    try {
      child.stdin.end();
    } catch {
      // already closed
    }
    setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
    }, 3000).unref();
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, 8000).unref();
    flushAndExit(code);
  }

  const onSignal = (sig) => {
    if (finished) return;
    if (aborting) {
      finish(EXIT.cancelled); // second signal: stop immediately
      return;
    }
    aborting = true;
    appendEvent(dir, "cancel_requested", undefined, sig);
    abort();
    graceTimer = setTimeout(() => finish(EXIT.cancelled), 5000);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  const timeout = Number(timeoutSec);
  if (Number.isFinite(timeout) && timeout > 0) {
    timeoutTimer = setTimeout(() => {
      if (finished) return;
      timedOut = true;
      appendEvent(dir, "timeout", undefined, `${timeout}s`);
      abort();
      graceTimer = setTimeout(() => finish(EXIT.timeout), 5000);
    }, timeout * 1000);
  }

  function recordSessionInfo(data) {
    if (!data || typeof data !== "object") return;
    const file = typeof data.sessionFile === "string" ? data.sessionFile : null;
    const sid = typeof data.sessionId === "string" ? data.sessionId : null;
    if (!file && !sid) return;
    try {
      const st = JSON.parse(readFileSync(statusPath(id), "utf8"));
      let changed = false;
      if (file && st.session_file !== file) {
        st.session_file = file;
        changed = true;
      }
      if (sid && st.omp_session_id !== sid) {
        st.omp_session_id = sid;
        changed = true;
      }
      if (changed) writeStatus(id, st);
    } catch {
      // session metadata is best-effort; the task itself still runs
    }
  }

  function sendPrompt() {
    if (startedPrompt || finished) return;
    startedPrompt = true;
    clearTimeout(negotiateTimer);
    resetIdleTimer();
    send({ id: promptId, type: "prompt", message: prompt });
  }

  function beginPrompt() {
    // For a fresh session, ask for its file/id before prompting so reply can
    // resume even if the task is killed later in this run.
    if (!resumeTarget && !sessionInfoRequested) {
      sessionInfoRequested = true;
      send({ id: stateId, type: "get_state" });
      setTimeout(() => sendPrompt(), 2000).unref();
      return;
    }
    sendPrompt();
  }

  // Local/slash prompts set agentInvoked=false. Empty text is allowed here
  // (e.g. a no-op slash); errors without text fail.
  function finishLocalPrompt() {
    if (aborting) return finish(EXIT.cancelled);
    if (timedOut) return finish(EXIT.timeout);
    if (idleTimedOut) return finish(EXIT.failed);
    if (lastError && !lastText) return finish(EXIT.failed);
    return finish(EXIT.done);
  }

  // Align with GAP agent_settled: cancelled/timeout/idle win first; then
  // error-without-text → failed; empty assistant text → failed; else done.
  // Local prompts reuse the looser finishLocalPrompt rules.
  function finishCompleted() {
    if (localPrompt) return finishLocalPrompt();
    if (aborting) return finish(EXIT.cancelled);
    if (timedOut) return finish(EXIT.timeout);
    if (idleTimedOut) return finish(EXIT.failed);
    if (lastError && !lastText) return finish(EXIT.failed);
    if (!lastText) {
      lastError ||= "no assistant text";
      return finish(EXIT.failed);
    }
    return finish(EXIT.done);
  }

  function finishForPromptResult(rec) {
    promptResult = rec;
    if (rec.status === "error") {
      lastError = rec.error?.message || lastError || "prompt error";
      appendEvent(dir, "error", undefined, lastError);
      if (aborting) return finish(EXIT.cancelled);
      if (timedOut) return finish(EXIT.timeout);
      return finish(EXIT.failed);
    }
    if (rec.status === "aborted") {
      appendEvent(dir, "prompt_aborted");
      if (aborting) return finish(EXIT.cancelled);
      if (timedOut) return finish(EXIT.timeout);
      if (idleTimedOut) return finish(EXIT.failed);
      lastError ||= "aborted";
      return finish(EXIT.failed);
    }
    // status === "completed"
    if (rec.sessionSettled === false) {
      appendEvent(dir, "prompt_completed", undefined, "waiting for session_settled");
      return; // wait for session_settled / a terminal agent_end + settle
    }
    return finishCompleted();
  }

  let buf = Buffer.alloc(0);
  let assemble = createFrameAssembler();
  child.stdout.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let i;
    while ((i = buf.indexOf(10)) >= 0) {
      // split on LF only; U+2028/U+2029 are valid inside JSON strings
      let line = buf.subarray(0, i).toString("utf8");
      buf = buf.subarray(i + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      // Any stdout RPC frame (including a chunk) refreshes the idle timer.
      resetIdleTimer();
      let frame;
      try {
        frame = assemble(rec);
      } catch (e) {
        appendEvent(dir, "rpc_frame_error", undefined, e.message);
        assemble = createFrameAssembler();
        continue;
      }
      if (!frame) continue;
      checkApprovals();
      handleEvent(frame);
    }
  });

  function handleEvent(rec) {
    const type = rec.type;

    if (type === "ready") {
      appendEvent(dir, "ready", undefined, `protocol=${rec.protocolVersion ?? "?"}`);
      const supports2 = Array.isArray(rec.supportedProtocolVersions)
        ? rec.supportedProtocolVersions.includes(2)
        : rec.protocolVersion === 2;
      if (supports2) {
        send({ id: negotiateId, type: "negotiate_protocol", protocolVersion: 2 });
        negotiateTimer = setTimeout(() => {
          appendEvent(dir, "protocol", undefined, "v2 negotiation timed out; using v1");
          beginPrompt();
        }, 3000);
      } else {
        appendEvent(dir, "protocol", undefined, "v1");
        beginPrompt();
      }
      return;
    }

    if (type === "response") {
      if (rec.id === negotiateId && rec.command === "negotiate_protocol") {
        if (rec.success && rec.data?.protocolVersion === 2) {
          appendEvent(dir, "protocol", undefined, "v2");
        } else {
          appendEvent(dir, "protocol", undefined, "v1 (negotiation refused)");
        }
        beginPrompt();
        return;
      }
      if (rec.id === stateId && rec.command === "get_state") {
        if (rec.success) recordSessionInfo(rec.data);
        else appendEvent(dir, "error", undefined, rec.error || "get_state failed");
        sendPrompt();
        return;
      }
      if (rec.id === promptId && rec.command === "prompt") {
        if (!rec.success) {
          lastError = rec.error || "prompt rejected";
          appendEvent(dir, "error", undefined, lastError);
          finish(EXIT.failed);
        } else if (rec.data?.agentInvoked === false) {
          // Local/slash handling: usually no prompt_result; give a short grace
          // so preceding/following command_output can populate lastText.
          localPrompt = true;
          appendEvent(dir, "prompt_local", undefined, "agentInvoked=false");
          if (!fallbackTimer) {
            fallbackTimer = setTimeout(() => {
              if (finished || promptResult) return;
              finishLocalPrompt();
            }, 500);
          }
        }
        return;
      }
      if (rec.id === promptId && rec.command === "abort_and_prompt") {
        if (!rec.success) {
          lastError = rec.error || "abort_and_prompt rejected";
          appendEvent(dir, "error", undefined, lastError);
          finish(EXIT.failed);
        }
        return;
      }
      if (!rec.success && rec.error) {
        appendEvent(dir, "error", undefined, `${rec.command || "command"}: ${rec.error}`);
      }
      return;
    }

    if (type === "agent_start") {
      appendEvent(dir, "agent_start");
      return;
    }
    if (type === "turn_start") {
      appendEvent(dir, "turn_start");
      return;
    }
    if (type === "turn_end") {
      appendEvent(dir, "turn_end");
      return;
    }
    if (type === "message_end" && rec.message?.role === "assistant") {
      const text = textOf(rec.message);
      if (text) {
        lastText = text;
        try {
          writeResult(dir, text);
        } catch {
          // ignore
        }
      }
      if (rec.message.stopReason === "error" || rec.message.errorMessage) {
        lastError = rec.message.errorMessage || "assistant error";
        appendEvent(dir, "error", undefined, lastError);
      }
      const note =
        text ||
        (rec.message.stopReason && rec.message.stopReason !== "toolUse"
          ? rec.message.stopReason
          : undefined);
      appendEvent(dir, "message_end", undefined, note);
      return;
    }
    if (type === "tool_execution_start") {
      appendEvent(dir, "tool_execution_start", rec.toolName, toolSummary(rec.args ?? rec.input));
      return;
    }
    if (type === "tool_execution_end") {
      const duration = Number.isFinite(rec.durationMs) ? `${rec.durationMs}ms` : "";
      appendEvent(
        dir,
        "tool_execution_end",
        rec.toolName,
        [rec.isError ? "error" : "ok", duration].filter(Boolean).join(" "),
      );
      return;
    }
    if (type === "command_output") {
      // Local slash/commands may stream text here instead of an assistant message.
      const t =
        typeof rec.text === "string"
          ? rec.text
          : typeof rec.output === "string"
            ? rec.output
            : typeof rec.content === "string"
              ? rec.content
              : "";
      if (t.trim()) {
        lastText = t.trim();
        appendEvent(dir, "command_output", undefined, lastText);
      }
      return;
    }
    if (type === "agent_end") {
      const terminal = rec.isTerminal !== false;
      appendEvent(
        dir,
        "agent_end",
        undefined,
        [terminal ? "terminal" : "continues", rec.awaitingAsyncWork ? "asyncWork" : ""]
          .filter(Boolean)
          .join(" "),
      );
      if (terminal && promptResult?.status === "completed" && promptResult.sessionSettled !== false) {
        finishCompleted();
      } else if (terminal && !promptResult && !fallbackTimer) {
        // Protocol watchdog: prompt_result normally arrives immediately after
        // agent_end, but never hang if an older server omits it.
        fallbackTimer = setTimeout(() => {
          if (finished || promptResult) return;
          finishCompleted();
        }, 2500);
      }
      return;
    }
    if (type === "prompt_result") {
      if (rec.id && rec.id !== promptId) {
        appendEvent(dir, "prompt_result", undefined, `ignored id=${rec.id}`);
        return;
      }
      appendEvent(
        dir,
        "prompt_result",
        undefined,
        [rec.status, rec.error?.message, rec.sessionSettled === false ? "settling" : ""]
          .filter(Boolean)
          .join(" "),
      );
      finishForPromptResult(rec);
      return;
    }
    if (type === "session_settled") {
      appendEvent(dir, "session_settled");
      if (promptResult?.status === "completed") {
        finishCompleted();
      }
      return;
    }
    if (type === "extension_ui_request") {
      if (rec.id && INTERACTIVE_UI.has(rec.method)) {
        send({ type: "extension_ui_response", id: rec.id, cancelled: true });
        appendEvent(dir, "extension_ui_request", undefined, `auto-cancelled ${rec.method}`);
      }
      return;
    }
    if (type === "extension_error") {
      appendEvent(dir, "extension_error", undefined, `${rec.event}: ${rec.error}`);
      return;
    }
    if (type === "notice") {
      appendEvent(dir, "notice", undefined, [rec.level, rec.message].filter(Boolean).join(" "));
      return;
    }
    if (type === "rpc_frame_error") {
      appendEvent(dir, "rpc_frame_error", undefined, rec.originalType || rec.error);
      return;
    }
    if (type === "auto_retry_start") {
      appendEvent(
        dir,
        "auto_retry_start",
        undefined,
        `attempt ${rec.attempt}/${rec.maxAttempts} ${rec.errorMessage || ""}`,
      );
      if (/UND_ERR|socket|other side closed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed|connection error|terminated|network/i.test(rec.errorMessage || "")) {
        // Connection error (often right after the box wakes): heal the model
        // path in parallel with OMP's own retry.
        runPreflightAsync(dir, `attempt ${rec.attempt}`);
      }
      return;
    }
    if (type === "auto_retry_end") {
      appendEvent(dir, "auto_retry_end", undefined, rec.success ? "ok" : rec.finalError || "failed");
      return;
    }
    if (type === "auto_compaction_start" || type === "manual_compaction_start") {
      appendEvent(dir, type, undefined, rec.reason || rec.action);
      return;
    }
    if (type === "auto_compaction_end" || type === "manual_compaction_end") {
      appendEvent(
        dir,
        type,
        undefined,
        rec.aborted ? "aborted" : rec.skipped ? "skipped" : rec.errorMessage || "ok",
      );
      return;
    }
    if (type === "thinking_level_changed") {
      appendEvent(dir, "thinking_level_changed", undefined, rec.thinkingLevel || rec.level);
      return;
    }
    if (type === "model_changed") {
      appendEvent(dir, "model_changed", undefined, rec.model?.id || rec.model);
      return;
    }
    if (type === "queue_update") {
      return;
    }
  }

  child.stderr?.on("data", (d) => {
    stderrBuf += d.toString("utf8");
    if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000);
  });

  child.on("error", (e) => {
    lastError = `spawn failed: ${e.message}`;
    appendEvent(dir, "error", undefined, lastError);
    finish(EXIT.failed);
  });

  child.on("exit", (code) => {
    if (finished) return;
    lastError ||= `omp exited early (code ${code})`;
    appendEvent(dir, "omp_exit", undefined, `code=${code}`);
    finish(aborting ? EXIT.cancelled : timedOut ? EXIT.timeout : EXIT.failed);
  });

  resetIdleTimer();
}

// -------------------------------------------------------------- subcommands

// Owner routing: Bots should ack only their own tasks using an owner filter.
// Store a string or null; legacy tasks without this field are treated as null.
const OWNER_NONE = "none";

function taskOwner(flags) {
  if (flags.owner !== undefined) {
    const s = String(flags.owner).trim();
    if (!s) usageError(`--owner needs a non-empty value: ${JSON.stringify(flags.owner)}`);
    if (/\s/.test(s)) usageError(`invalid --owner (no whitespace): ${flags.owner}`);
    return s;
  }
  const env = String(process.env.OMP_TASK_OWNER ?? "").trim();
  if (env) {
    if (!/\s/.test(env)) return env;
    process.stderr.write(`omp-task: warning: invalid OMP_TASK_OWNER (contains whitespace): ${env}\n`);
  }
  process.stderr.write("omp-task: warning: --owner was not specified; completion cannot be routed to the dispatching Bot\n");
  return null;
}

// Owner filter: undefined = all; null = unowned only; string = exact match.
function ownerFilter(flags) {
  if (flags.owner === undefined) return undefined;
  const s = String(flags.owner).trim();
  if (!s) usageError("--owner needs a non-empty value (--owner none matches unowned tasks)");
  return s === OWNER_NONE ? null : s;
}

function ownerMatches(status, filter) {
  if (filter === undefined) return true;
  const owner = status?.owner ?? null;
  return filter === null ? owner === null : owner === filter;
}

const ownerLabel = (status) => {
  const owner = status?.owner;
  return owner === undefined || owner === null || owner === "" ? "-" : String(owner);
};

function timeoutOf(flags) {
  if (flags.timeout === undefined) return DEFAULT_TIMEOUT;
  const n = Number(flags.timeout);
  if (!Number.isFinite(n) || n < 0) usageError(`invalid --timeout: ${flags.timeout}`);
  return n;
}

function idleTimeoutOf(flags) {
  if (flags["idle-timeout"] !== undefined) {
    const n = Number(flags["idle-timeout"]);
    if (!Number.isFinite(n) || n < 0) usageError(`invalid --idle-timeout: ${flags["idle-timeout"]}`);
    return n;
  }
  if (process.env.OMP_TASK_IDLE_TIMEOUT !== undefined) {
    const n = Number(process.env.OMP_TASK_IDLE_TIMEOUT);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_IDLE_TIMEOUT;
}

function newTaskId(session) {
  const base = `${session}-${stamp()}`;
  let id = base;
  let i = 2;
  while (existsSync(taskDir(id))) id = `${base}-${i++}`;
  return id;
}

function cmdRun(pos, flags) {
  const timeoutSec = timeoutOf(flags);
  const idleTimeoutSec = idleTimeoutOf(flags);
  const cwdArg = pos[0];
  const prompt = pos[1];
  if (!cwdArg || prompt === undefined || prompt === "") {
    usageError('run needs <cwd> and a non-empty "<prompt>"');
  }
  if (!flags.session) usageError("run needs --session <name>");
  const cwd = resolve(cwdArg);
  if (!isDir(cwd)) usageError(`cwd is not a directory: ${cwd}`);
  const session = cleanSession(flags.session);
  assertSessionFree(session);
  const owner = taskOwner(flags);
  const notifyPrefix =
    typeof flags["notify-prefix"] === "string" && flags["notify-prefix"]
      ? flags["notify-prefix"]
      : DEFAULT_NOTIFY_PREFIX;
  const model = typeof flags.model === "string" && flags.model ? flags.model : DEFAULT_MODEL;
  const thinking =
    typeof flags.thinking === "string" && flags.thinking ? flags.thinking : DEFAULT_THINKING;
  const guard = flags.guard === "off" ? "off" : "on";

  const id = newTaskId(session);
  const status = {
    id,
    session,
    owner,
    cwd,
    model,
    notify_prefix: notifyPrefix,
    state: "queued",
    pid: null,
    created_at: iso(),
    started_at: null,
    ended_at: null,
    exit_code: null,
    error: null,
    reported: false,
    session_file: null,
    omp_session_id: null,
    runs: [],
    options: {
      thinking,
      write: !flags["no-write"],
      web: !flags["no-web"],
      guard,
    },
  };
  writeStatus(id, status);
  process.stdout.write(`TASK ${id}\n`);
  execute(id, prompt, timeoutSec, idleTimeoutSec);
}

function cmdReply(pos, flags) {
  const timeoutSec = timeoutOf(flags);
  const idleTimeoutSec = idleTimeoutOf(flags);
  const id = pos[0];
  const prompt = pos[1];
  if (!id || prompt === undefined || prompt === "") {
    usageError('reply needs <id> and a non-empty "<prompt>"');
  }
  const status = readStatus(id);
  if (flags.owner !== undefined) {
    const expectedOwner = String(flags.owner).trim();
    if (!expectedOwner) usageError("--owner needs a non-empty value");
    if (status.owner !== expectedOwner) {
      process.stderr.write(`omp-task: owner mismatch (expected "${expectedOwner}", task owner is "${ownerLabel(status)}")\n`);
      process.exit(2);
    }
  }
  if (status.state === "running") fail(`task ${id} is still running; wait or cancel it first`);
  if (!TERMINAL.has(status.state)) fail(`task ${id} is in state ${status.state}`);
  if (!isDir(status.cwd)) fail(`task cwd no longer exists: ${status.cwd}`);
  assertSessionFree(status.session, id);
  execute(id, prompt, timeoutSec, idleTimeoutSec);
}

function findApprovalReq(dir, req) {
  const p = join(dir, "approvals.jsonl");
  if (!existsSync(p)) return null;
  try {
    const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        if (item && item.req === req) return item;
      } catch {}
    }
  } catch {}
  return null;
}

function appendApprovedCommand(dir, command) {
  const p = join(dir, "approved.json");
  let list = [];
  if (existsSync(p)) {
    try {
      const data = JSON.parse(readFileSync(p, "utf8"));
      if (Array.isArray(data)) list = data;
    } catch {}
  }
  if (!list.includes(command)) {
    list.push(command);
    writeFileSync(p, JSON.stringify(list, null, 2) + "\n");
  }
}

async function waitForNotRunning(id, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await sleep(200);
    let now;
    try { now = JSON.parse(readFileSync(statusPath(id), "utf8")); } catch { now = null; }
    if (now && now.state !== "running") return now;
  }
  return null;
}

async function cmdApprove(pos, flags) {
  const id = pos[0];
  const req = pos[1];
  if (!id || !req) {
    usageError("approve needs <id> and <req>");
  }
  const status = readStatus(id);
  if (flags.owner !== undefined) {
    const expectedOwner = String(flags.owner).trim();
    if (!expectedOwner) usageError("--owner needs a non-empty value");
    if (status.owner !== expectedOwner) {
      process.stderr.write(`omp-task: owner mismatch (expected "${expectedOwner}", task owner is "${ownerLabel(status)}")\n`);
      process.exit(2);
    }
  }
  const dir = taskDir(id);
  const item = findApprovalReq(dir, req);
  if (!item || !item.command) {
    fail(`approval request not found: ${req}`);
  }
  appendApprovedCommand(dir, item.command);
  appendEvent(dir, "approved", undefined, `req=${req} cmd=${item.command}`);

  const msg = `req=${req} 已放行，可以执行这条命令：${item.command}`;

  if (status.state === "running") {
    await waitForNotRunning(id);
  }

  const currentSt = readStatus(id);
  if (currentSt.state === "running") {
    fail(`task ${id} is still running; command added to approved.json, send message once finished`);
  }
  if (!isDir(currentSt.cwd)) fail(`task cwd no longer exists: ${currentSt.cwd}`);
  assertSessionFree(currentSt.session, id);

  const timeoutSec = timeoutOf(flags);
  const idleTimeoutSec = idleTimeoutOf(flags);
  execute(id, msg, timeoutSec, idleTimeoutSec);
}

async function cmdDeny(pos, flags) {
  const id = pos[0];
  const req = pos[1];
  if (!id || !req) {
    usageError("deny needs <id> and <req>");
  }
  const status = readStatus(id);
  if (flags.owner !== undefined) {
    const expectedOwner = String(flags.owner).trim();
    if (!expectedOwner) usageError("--owner needs a non-empty value");
    if (status.owner !== expectedOwner) {
      process.stderr.write(`omp-task: owner mismatch (expected "${expectedOwner}", task owner is "${ownerLabel(status)}")\n`);
      process.exit(2);
    }
  }
  const dir = taskDir(id);
  const item = findApprovalReq(dir, req);
  if (!item || !item.command) {
    fail(`approval request not found: ${req}`);
  }
  appendEvent(dir, "denied", undefined, `req=${req} cmd=${item.command}`);

  const msg = "被拒绝，不要执行，换个不删除的做法或者直接跳过";

  if (status.state === "running") {
    await waitForNotRunning(id);
  }

  const currentSt = readStatus(id);
  if (currentSt.state === "running") {
    fail(`task ${id} is still running; wait or cancel it before denying`);
  }
  if (!isDir(currentSt.cwd)) fail(`task cwd no longer exists: ${currentSt.cwd}`);
  assertSessionFree(currentSt.session, id);

  const timeoutSec = timeoutOf(flags);
  const idleTimeoutSec = idleTimeoutOf(flags);
  execute(id, msg, timeoutSec, idleTimeoutSec);
}

function cmdStatus(pos) {
  const id = pos[0];
  if (!id) usageError("status needs <id>");
  const status = readStatus(id);
  const dir = taskDir(id);
  const resultPath = join(dir, "result.md");
  const events = readEvents(dir, 5);
  const lines = [
    `id:       ${status.id}`,
    `state:    ${status.state}`,
    `owner:    ${ownerLabel(status)}`,
    `session:  ${status.session}`,
    `model:    ${status.model || "(default)"}`,
    `cwd:      ${status.cwd}`,
    `created:  ${lt(status.created_at)} (${humanAge(status.created_at)} ago)`,
    `started:  ${lt(status.started_at)}`,
    `ended:    ${lt(status.ended_at)}`,
    `duration: ${humanDuration(status.started_at, status.ended_at)}`,
    `runs:     ${Array.isArray(status.runs) ? status.runs.length : 0}`,
    `result:   ${resultPath}${existsSync(resultPath) ? "" : " (missing)"}`,
    `reported: ${status.reported === true}`,
  ];
  if (status.session_file) lines.push(`omp-sess: ${status.session_file}`);
  if (status.error) lines.push(`error:    ${status.error}`);
  lines.push("events:");
  if (!events.length) lines.push("  (none)");
  for (const ev of events) lines.push(`  ${fmtEvent(ev, 100)}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

function cmdList(flags) {
  const ids = listTaskIds().sort();
  const filter = ownerFilter(flags);
  const rows = [];
  for (const id of ids) {
    let status;
    try {
      status = JSON.parse(readFileSync(statusPath(id), "utf8"));
    } catch {
      continue;
    }
    const created = status.created_at ? Date.parse(status.created_at) : NaN;
    const recent = Number.isFinite(created) && Date.now() - created < 24 * 3600 * 1000;
    if (!flags.all && status.state !== "running" && !recent) continue;
    if (!ownerMatches(status, filter)) continue;
    rows.push({ status, created });
  }
  rows.sort((a, b) => (b.created || 0) - (a.created || 0));
  for (const { status } of rows) {
    const runs = Array.isArray(status.runs) ? status.runs.length : 0;
    process.stdout.write(
      `${status.id}  owner=${ownerLabel(status)}  ${status.state}  runs=${runs}  ` +
        `created=${humanAge(status.created_at)} ago\n`,
    );
  }
}

function cmdLog(pos, flags) {
  const id = pos[0];
  if (!id) usageError("log needs <id>");
  readStatus(id); // validates existence
  const n = Number.parseInt(flags.n ?? "30", 10);
  const limit = Number.isFinite(n) && n > 0 ? n : 30;
  const events = readEvents(taskDir(id), limit);
  if (!events.length) {
    process.stdout.write("(no events)\n");
    return;
  }
  for (const ev of events) process.stdout.write(`${fmtEvent(ev)}\n`);
}

async function cmdCancel(pos) {
  const id = pos[0];
  if (!id) usageError("cancel needs <id>");
  const status = readStatus(id);
  if (status.state !== "running") fail(`task ${id} is not running (state=${status.state})`);
  if (!status.pid || !isAlive(status.pid)) {
    // Reaching here means another subcommand has not noticed yet.
    const deadPid = status.pid;
    const end = iso();
    status.state = "interrupted";
    status.ended_at = end;
    status.error = status.error || "orphaned: process no longer running";
    status.pid = null;
    writeStatus(id, status);
    appendEvent(taskDir(id), "orphan_detected", undefined, "state=interrupted");
    fail(`task ${id}: process ${deadPid ?? "(none)"} not running, marked interrupted`);
  }

  appendEvent(taskDir(id), "cancel_signal", undefined, `SIGTERM -> ${status.pid}`);
  try {
    process.kill(status.pid, "SIGTERM");
  } catch (e) {
    fail(`could not signal pid ${status.pid}: ${e.message}`);
  }

  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    await sleep(200);
    let now;
    try {
      now = JSON.parse(readFileSync(statusPath(id), "utf8"));
    } catch {
      now = null;
    }
    if (!now || now.state !== "running") {
      const state = now?.state || "unknown";
      process.stdout.write(`CANCELLED ${id} state=${state}\n`);
      return;
    }
  }

  // The run process did not finish in time: force it and record the outcome.
  try {
    process.kill(status.pid, "SIGKILL");
  } catch {
    // already gone
  }
  const end = iso();
  status.state = "cancelled";
  status.ended_at = end;
  status.exit_code = EXIT.cancelled;
  status.pid = null;
  status.error = "cancelled (forced after SIGTERM timeout)";
  const last = Array.isArray(status.runs) && status.runs.length
    ? status.runs[status.runs.length - 1]
    : null;
  if (last) {
    last.ended_at = end;
    last.exit_code = EXIT.cancelled;
  }
  writeStatus(id, status);
  appendEvent(taskDir(id), "cancel_forced", undefined, "SIGKILL");
  process.stdout.write(`CANCELLED ${id} state=cancelled (forced)\n`);
}

function cmdPending(flags) {
  const filter = ownerFilter(flags);
  const rows = [];
  for (const id of listTaskIds()) {
    let status;
    try {
      status = JSON.parse(readFileSync(statusPath(id), "utf8"));
    } catch {
      continue;
    }
    if (!TERMINAL.has(status.state)) continue;
    if (status.reported === true) continue;
    if (!ownerMatches(status, filter)) continue;
    rows.push(status);
  }
  rows.sort((a, b) => String(a.ended_at || "").localeCompare(String(b.ended_at || "")));
  for (const status of rows) {
    const result = join(taskDir(status.id), "result.md");
    process.stdout.write(
      `${status.id}  owner=${ownerLabel(status)}  ${status.state}  ended=${lt(
        status.ended_at,
      )}  result=${result}${existsSync(result) ? "" : " (missing)"}\n`,
    );
  }
}

function cmdAck(pos, flags) {
  const ids = pos.filter(Boolean);
  if (!ids.length) usageError("ack needs <id> [<id>...]");
  const filter = ownerFilter(flags);
  const refused = [];
  for (const id of ids) {
    const status = readStatus(id);
    if (!ownerMatches(status, filter)) {
      const why =
        filter === null
          ? `owner=${ownerLabel(status)} does not match --owner none`
          : `owner=${ownerLabel(status)} does not match --owner ${filter}`;
      process.stderr.write(`omp-task: refusing ack ${id}: ${why} (cannot ack another Bot's task)\n`);
      refused.push(id);
      continue;
    }
    status.reported = true;
    writeStatus(id, status);
    appendEvent(taskDir(id), "ack", undefined, "reported=true");
    process.stdout.write(`ACK ${id}  owner=${ownerLabel(status)}\n`);
  }
  if (refused.length) flushAndExit(1);
}

// ------------------------------------------------------------------- argv

const VALUE_FLAGS = new Set(["session", "timeout", "idle-timeout", "model", "thinking", "n", "owner", "notify-prefix", "guard"]);
const BOOL_FLAGS = new Set(["no-write", "no-web", "all", "help"]);

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a === "-n") {
      if (i + 1 >= argv.length) usageError("missing value for -n");
      flags.n = argv[++i];
      continue;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        const name = a.slice(2, eq);
        if (!VALUE_FLAGS.has(name)) usageError(`unknown option: --${name}`);
        flags[name] = a.slice(eq + 1);
        continue;
      }
      const name = a.slice(2);
      if (VALUE_FLAGS.has(name)) {
        if (i + 1 >= argv.length) usageError(`missing value for --${name}`);
        flags[name] = argv[++i];
      } else if (BOOL_FLAGS.has(name)) {
        flags[name] = true;
      } else {
        usageError(`unknown option: --${name}`);
      }
      continue;
    }
    pos.push(a);
  }
  return { flags, pos };
}

const USAGE = `usage:
  omp-task run <cwd> "<prompt>" --session <name> [--owner <agent id>] [--timeout sec]
              [--idle-timeout sec] [--guard on|off]
              [--model provider/model] [--thinking off|minimal|low|medium|high|xhigh|max|auto]
              [--notify-prefix <name>]
              [--no-write] [--no-web]
  omp-task reply <id> "<prompt>" [--owner <agent id>] [--timeout sec] [--idle-timeout sec]
  omp-task approve <id> <req> [--owner <agent id>] [--timeout sec] [--idle-timeout sec]
  omp-task deny <id> <req> [--owner <agent id>] [--timeout sec] [--idle-timeout sec]
  omp-task status <id>
  omp-task list [--all] [--owner <agent id>|none]
  omp-task log <id> [-n 30]
  omp-task cancel <id>
  omp-task pending [--owner <agent id>|none]
  omp-task ack <id> [<id>...] [--owner <agent id>|none]

  --owner <id>            dispatching agent; defaults to OMP_TASK_OWNER, or null with a warning
  --owner none            match only tasks with owner=null
  --idle-timeout <sec>    fail if OMP emits no RPC events for this long (default 300)
  --guard on|off          disaster command protection extension (default on)
  --notify-prefix <name>  read webhook URL and key from <NAME>_OMP_NOTIFY_URL and <NAME>_OMP_NOTIFY_KEY

env:
  OMP_TASK_DIR            task store (default ~/.omp/tasks)
  OMP_TASK_SESSION_DIR    OMP session dir (default ~/.omp/agent/sessions/tasks)
  OMP_TASK_OWNER          default owner for run (fallback when --owner is absent)
  OMP_TASK_IDLE_TIMEOUT   default idle timeout in seconds (default 300)
  OMP_TASK_PREFLIGHT      preflight script (default: omp-preflight beside omp-task, if executable)
  OMP_GUARD               disable guard extension when set to off (default on)
  OMP_TASK_MODEL          default model for run (fallback when --model is absent)
  OMP_TASK_THINKING       default thinking level (default: medium)
  OMP_TASK_NOTIFY_PREFIX  default notify prefix (fallback when --notify-prefix is absent)
  OMP_NOTIFY_URL          webhook URL when no notify prefix is set
  OMP_NOTIFY_SECRET       webhook Bearer token when no notify prefix is set
  OMP_NOTIFY_OFF          set to 1 to disable notifications
  OMP_BIN                 omp executable (default: omp)
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(USAGE);
    return;
  }
  const { flags, pos } = parseArgs(rest);
  if (flags.help) {
    process.stdout.write(USAGE);
    return;
  }

  const known = new Set([
    "run", "reply", "approve", "deny", "status", "list", "log", "cancel", "pending", "ack",
  ]);
  if (!known.has(cmd)) usageError(`unknown command: ${cmd}`);

  orphanCheck();

  switch (cmd) {
    case "run":
      return cmdRun(pos, flags);
    case "reply":
      return cmdReply(pos, flags);
    case "approve":
      return cmdApprove(pos, flags);
    case "deny":
      return cmdDeny(pos, flags);
    case "status":
      return cmdStatus(pos);
    case "list":
      return cmdList(flags);
    case "log":
      return cmdLog(pos, flags);
    case "cancel":
      return cmdCancel(pos);
    case "pending":
      return cmdPending(flags);
    case "ack":
      return cmdAck(pos, flags);
  }
}

main().catch((e) => {
  process.stderr.write(`omp-task: ${e?.message || e}\n`);
  process.exit(1);
});
