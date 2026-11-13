#!/usr/bin/env node
// omp-call.mjs — one-shot RPC client for OMP (`omp --mode rpc`).
//
// Usage:
//   omp-call.mjs <cwd> "<prompt>" [--model provider/model] [--allow-write]
//                [--thinking off|minimal|low|medium|high|xhigh|max|auto]
//                [--timeout sec] [--no-web] [--verbose]
//                [--session-dir <dir> | --resume <session.jsonl>]
//
// Prints the final assistant text. No task store: use omp-task for tracked work.
// Node 22+, no third-party dependencies.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const take = (name) => {
  // Remove every occurrence; the last value wins so wrapper defaults can be
  // overridden by flags the caller appends later.
  let value;
  let i;
  while ((i = argv.indexOf(name)) >= 0) {
    value = argv[i + 1];
    argv.splice(i, 2);
  }
  return value;
};
const has = (name) => {
  let found = false;
  let i;
  while ((i = argv.indexOf(name)) >= 0) {
    found = true;
    argv.splice(i, 1);
  }
  return found;
};

const allowWrite = has("--allow-write");
const verbose = has("--verbose");
const noWeb = has("--no-web");
const thinking = take("--thinking") ?? "off";
const timeoutSec = Number(take("--timeout") ?? 300);
const model = take("--model") ?? process.env.OMP_CALL_MODEL ?? null;
const sessionDir = take("--session-dir");
const resumeFile = take("--resume");

const [cwdArg, ...rest] = argv;
const prompt = rest.join(" ");
if (!cwdArg || !prompt) {
  console.error(
    'usage: omp-call.mjs <cwd> "<prompt>" [--model provider/model] [--allow-write] ' +
      "[--thinking level] [--timeout sec] [--no-web] [--verbose] " +
      "[--session-dir dir | --resume session.jsonl]",
  );
  process.exit(2);
}
if (sessionDir && resumeFile) {
  console.error("omp-call.mjs: --session-dir and --resume are mutually exclusive");
  process.exit(2);
}

const OMP_BIN = process.env.OMP_BIN || "omp";
const READ_TOOLS = ["read", "glob", "grep"];
const WRITE_TOOLS = ["read", "bash", "edit", "write", "glob", "grep", "todo", "wait"];
const tools = [...(allowWrite ? WRITE_TOOLS : READ_TOOLS), ...(noWeb ? [] : ["web_search"])].join(",");

function findGuardExtensionPath() {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  for (const p of [
    resolve(currentDir, "..", "extensions", "omp-guard.ts"),
    resolve(currentDir, "extensions", "omp-guard.ts"),
  ]) {
    if (existsSync(p)) return p;
  }
  return null;
}

const args = ["--mode", "rpc"];
if (resumeFile) args.push("--resume", resumeFile);
else if (sessionDir) args.push("--session-dir", sessionDir);
else args.push("--no-session");
if (model) args.push("--model", String(model));
if (thinking) args.push("--thinking", String(thinking));
args.push("--tools", tools, "--auto-approve");
if (process.env.OMP_GUARD !== "off") {
  const guard = findGuardExtensionPath();
  if (guard) args.push("-e", guard);
}

const child = spawn(OMP_BIN, args, {
  cwd: resolve(cwdArg),
  stdio: ["pipe", "pipe", verbose ? "inherit" : "pipe"],
});

let stderr = "";
child.stderr?.on("data", (d) => {
  stderr += d.toString("utf8");
  if (stderr.length > 4000) stderr = stderr.slice(-4000);
});

const send = (o) => {
  try {
    child.stdin.write(`${JSON.stringify(o)}\n`);
  } catch {
    // exit handler reports it
  }
};

const textOf = (m) =>
  Array.isArray(m?.content)
    ? m.content.filter((c) => c?.type === "text").map((c) => c.text || "").join("")
    : typeof m?.content === "string"
      ? m.content
      : "";

let lastText = "";
let lastError = "";
let done = false;
let exitCode = 1;
let startedPrompt = false;
let promptResult = null;
let settleTimer = null;
let localPrompt = false;
let localTimer = null;

function finish(code) {
  if (done) return;
  done = true;
  exitCode = code;
  clearTimeout(timer);
  clearTimeout(settleTimer);
  clearTimeout(localTimer);
  try {
    child.stdin.end();
  } catch {}
  setTimeout(() => {
    try { child.kill("SIGTERM"); } catch {}
  }, 3000).unref();
  setTimeout(() => {
    try { child.kill("SIGKILL"); } catch {}
  }, 8000).unref();
}

let timer = null;
if (Number.isFinite(timeoutSec) && timeoutSec > 0) {
  timer = setTimeout(() => {
    if (done) return;
    console.error(`timeout after ${timeoutSec}s`);
    send({ type: "abort" });
    finish(124);
  }, timeoutSec * 1000);
}

function sendPrompt() {
  if (startedPrompt || done) return;
  startedPrompt = true;
  send({ id: "p1", type: "prompt", message: prompt });
}

// Protocol v2 frame reassembly (see omp-task.mjs for the wire contract).
let chunkState = null;
function pushFrame(rec) {
  if (!rec || rec.type !== "rpc_chunk") {
    if (chunkState) {
      chunkState = null;
      throw new Error("rpc chunk sequence interrupted");
    }
    return rec;
  }
  const { chunkId, index, count, byteLength, data } = rec;
  if (
    typeof chunkId !== "string" || !chunkId || chunkId.length > 128 ||
    !Number.isSafeInteger(index) || !Number.isSafeInteger(count) ||
    !Number.isSafeInteger(byteLength) ||
    index < 0 || count < 2 || index >= count || byteLength < 0 ||
    typeof data !== "string"
  ) {
    throw new Error("invalid rpc chunk metadata");
  }
  const bytes = Buffer.from(data, "base64");
  if (!chunkState) {
    if (index !== 0) throw new Error("rpc chunk sequence must start at index 0");
    chunkState = { chunkId, count, byteLength, nextIndex: 0, chunks: [], receivedBytes: 0 };
  }
  if (
    chunkState.chunkId !== chunkId || chunkState.count !== count ||
    chunkState.byteLength !== byteLength || chunkState.nextIndex !== index
  ) {
    throw new Error("rpc chunk sequence mismatch");
  }
  chunkState.chunks.push(bytes);
  chunkState.receivedBytes += bytes.byteLength;
  chunkState.nextIndex++;
  if (chunkState.receivedBytes > chunkState.byteLength) {
    throw new Error("rpc chunk sequence exceeds declared length");
  }
  if (chunkState.nextIndex < chunkState.count) return null;
  if (chunkState.receivedBytes !== chunkState.byteLength) {
    throw new Error("rpc chunk sequence length mismatch");
  }
  const text = Buffer.concat(chunkState.chunks).toString("utf8");
  chunkState = null;
  return JSON.parse(text);
}

// Local/slash prompts often produce command_output instead of assistant text.
// Empty text is acceptable there, but an error without output is not.
function finishLocal() {
  if (done) return;
  if (lastError && !lastText) finish(1);
  else finish(0);
}

// One completion rule for agent turns and prompt_result/session_settled.
function finishCompleted() {
  if (done) return;
  if (localPrompt) return finishLocal();
  // Match omp-task / GAP: require assistant text for a successful agent turn.
  if (lastError && !lastText) return finish(1);
  if (!lastText) {
    lastError ||= "no assistant text";
    return finish(1);
  }
  return finish(0);
}

function maybeFinish() {
  if (done) return;
  if (promptResult?.status === "error") {
    lastError = promptResult.error?.message || lastError || "prompt error";
    finish(1);
    return;
  }
  if (promptResult?.status === "aborted") {
    lastError ||= "aborted";
    finish(130);
    return;
  }
  if (promptResult?.status === "completed") finishCompleted();
}

let buf = Buffer.alloc(0);
child.stdout.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  let i;
  while ((i = buf.indexOf(10)) >= 0) {
    // split on LF only (not U+2028/U+2029)
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
    let r;
    try {
      r = pushFrame(rec);
    } catch (e) {
      lastError = e.message;
      chunkState = null;
      continue;
    }
    if (!r) continue;

    if (verbose) {
      const brief = { ...r };
      if (brief.messages) brief.messages = `[${brief.messages.length}]`;
      if (brief.message) brief.message = "<<message>>";
      console.error("[rpc]", JSON.stringify(brief).slice(0, 200));
    }

    if (r.type === "ready") {
      const supports2 = Array.isArray(r.supportedProtocolVersions)
        ? r.supportedProtocolVersions.includes(2)
        : r.protocolVersion === 2;
      if (supports2) {
        send({ id: "neg1", type: "negotiate_protocol", protocolVersion: 2 });
        setTimeout(() => sendPrompt(), 3000).unref();
      } else {
        sendPrompt();
      }
      continue;
    }
    if (r.type === "response") {
      if (r.id === "neg1" && r.command === "negotiate_protocol") {
        sendPrompt();
        continue;
      }
      if (r.id === "p1" && r.command === "prompt") {
        if (!r.success) {
          lastError = r.error || "prompt rejected";
          finish(1);
        } else if (r.data?.agentInvoked === false) {
          // Local/slash: no prompt_result usually follows; brief grace for output.
          localPrompt = true;
          if (!localTimer) {
            localTimer = setTimeout(() => {
              if (done || promptResult) return;
              finishLocal();
            }, 500);
            localTimer.unref?.();
          }
        }
        continue;
      }
      if (!r.success && r.error) lastError = `${r.command || "command"}: ${r.error}`;
      continue;
    }
    if (r.type === "command_output") {
      const t =
        typeof r.text === "string"
          ? r.text
          : typeof r.output === "string"
            ? r.output
            : typeof r.content === "string"
              ? r.content
              : "";
      if (t.trim()) lastText = t.trim();
      continue;
    }
    if (r.type === "message_end" && r.message?.role === "assistant") {
      const t = textOf(r.message);
      if (t) lastText = t;
      if (r.message.stopReason === "error" || r.message.errorMessage) {
        lastError = r.message.errorMessage || "assistant error";
      }
      continue;
    }
    if (r.type === "extension_ui_request") {
      if (r.id && ["select", "confirm", "input", "editor", "ask"].includes(r.method)) {
        send({ type: "extension_ui_response", id: r.id, cancelled: true });
      }
      continue;
    }
    if (r.type === "prompt_result") {
      if (r.id && r.id !== "p1") continue;
      promptResult = r;
      if (r.status === "completed" && r.sessionSettled === false) {
        // Background work may still append output; wait for session_settled.
        settleTimer = setTimeout(maybeFinish, 30000);
        settleTimer.unref?.();
      } else {
        maybeFinish();
      }
      continue;
    }
    if (r.type === "session_settled") {
      maybeFinish();
      continue;
    }
    if (r.type === "agent_end" && r.isTerminal !== false && !promptResult) {
      setTimeout(() => {
        if (done || promptResult) return;
        finishCompleted();
      }, 2500).unref();
    }
  }
});

child.on("error", (e) => {
  console.error("spawn failed:", e.message);
  process.exit(127);
});

child.on("exit", (code) => {
  if (!done) {
    lastError ||= `omp exited early (code ${code})`;
    exitCode = promptResult?.status === "completed" ? 0 : 1;
    clearTimeout(timer);
    clearTimeout(settleTimer);
  }
  if (lastText) process.stdout.write(`${lastText}\n`);
  if (exitCode && (lastError || stderr)) console.error(lastError || stderr.trim());
  process.exit(exitCode);
});
