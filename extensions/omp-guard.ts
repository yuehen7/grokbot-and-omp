/**
 * omp-guard.ts — GAO 防删库跑路扩展
 *
 * 仅针对灾难性的递归删除或抹盘操作进行拦截，其他常规操作一律放行。
 * 环境变量 OMP_GUARD=off 时扩展整体旁路。
 *
 * OMP 通过 `-e/--extension` 加载本文件；`omp-task` 会显式传入绝对路径。
 * 规则集与 GAP 的 pi-guard 字节级对齐（仅环境变量与提示前缀随 GAO 调整）。
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type ToolCallEvent = {
  toolName?: string;
  toolCallId?: string;
  input?: { command?: unknown };
};

type ExtensionAPI = {
  on(event: "tool_call", handler: (event: ToolCallEvent, ctx: unknown) => unknown): void;
};

export interface GuardResult {
  block: true;
  reason: string;
}

const DANGEROUS_TARGETS = new Set([
  "/",
  "/*",
  "~",
  "~/",
  "$HOME",
  "${HOME}",
  "/home",
  "/root",
  "/etc",
  "/usr",
  "/var",
  "/boot",
  "/opt",
  "/bin",
  "/lib",
  "/workspace",
  "..",
  "*",
]);

const FIND_DANGEROUS_ROOTS = new Set([
  "/",
  "~",
  "~/",
  "$HOME",
  "${HOME}",
]);

/**
 * 简单的 Shell token 解析，支持单双引号处理
 */
export function tokenizeShell(cmd: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escape = false;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (escape) {
      current += ch;
      escape = false;
      continue;
    }
    if (ch === "\\" && !inSingle) {
      escape = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (/\s/.test(ch) && !inSingle && !inDouble) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

/**
 * 拆解复合命令（&&, ||, ;, |, &）
 */
function splitCommands(fullCmd: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escape = false;

  for (let i = 0; i < fullCmd.length; i++) {
    const ch = fullCmd[i];
    if (escape) {
      current += ch;
      escape = false;
      continue;
    }
    if (ch === "\\") {
      current += ch;
      escape = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }
    if (!inSingle && !inDouble) {
      if (ch === ";" || ch === "\n") {
        if (current.trim()) parts.push(current.trim());
        current = "";
        continue;
      }
      if (ch === "&" || ch === "|") {
        const next = fullCmd[i + 1];
        if (next === ch) {
          // && 或 ||
          if (current.trim()) parts.push(current.trim());
          current = "";
          i++;
          continue;
        }
        // 单个 & 或 |
        if (current.trim()) parts.push(current.trim());
        current = "";
        continue;
      }
    }
    current += ch;
  }
  if (current.trim()) {
    parts.push(current.trim());
  }
  return parts;
}

function normalizeTarget(t: string): string {
  if (t === "/" || t === "/*" || t === "*") return t;
  if (t.endsWith("/") && t.length > 1) {
    return t.slice(0, -1);
  }
  return t;
}

/**
 * 检查单个子命令是否命中灾难操作规则
 */
function isDisasterSubcommand(subcmd: string): boolean {
  const tokens = tokenizeShell(subcmd);
  if (tokens.length === 0) return false;

  // 跳过命令前缀的环境变量赋值 (KEY=VAL) 以及 sudo、nohup 等
  let cmdIdx = 0;
  while (cmdIdx < tokens.length) {
    const t = tokens[cmdIdx];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      cmdIdx++;
      continue;
    }
    if (t === "sudo" || t === "nohup" || t === "exec") {
      cmdIdx++;
      continue;
    }
    break;
  }
  if (cmdIdx >= tokens.length) return false;

  const bin = tokens[cmdIdx];
  const args = tokens.slice(cmdIdx + 1);

  // 1. mkfs
  if (bin === "mkfs" || bin.startsWith("mkfs.")) {
    return true;
  }

  // 2. dd 写到 of=/dev/
  if (bin === "dd") {
    for (const a of args) {
      if (/^of=\s*['"]?\/dev\//.test(a)) {
        return true;
      }
    }
  }

  // 3. find 从 /、~、$HOME 出发并带 -delete
  if (bin === "find") {
    const hasDelete = args.includes("-delete");
    if (hasDelete) {
      // 提取 find 后面的路径参数（在任何以 - 开头的选项之前）
      for (const a of args) {
        if (a.startsWith("-")) break;
        const norm = normalizeTarget(a);
        if (FIND_DANGEROUS_ROOTS.has(a) || FIND_DANGEROUS_ROOTS.has(norm)) {
          return true;
        }
      }
    }
  }

  // 4. rm 带 -r、-R 或 --recursive，且目标属于危险目标
  if (bin === "rm") {
    let hasRecursive = false;
    let endOfOptions = false;
    const targets: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (!endOfOptions && a === "--") {
        endOfOptions = true;
        continue;
      }
      if (!endOfOptions && a.startsWith("--")) {
        if (a === "--recursive") {
          hasRecursive = true;
        }
        // --no-preserve-root 等其他 long flag
        continue;
      }
      if (!endOfOptions && a.startsWith("-") && a.length > 1) {
        // 短 flag 集合，如 -rf, -r, -R, -fr
        if (/[rR]/.test(a)) {
          hasRecursive = true;
        }
        continue;
      }
      // 路径目标
      targets.push(a);
    }

    if (hasRecursive) {
      for (const t of targets) {
        const norm = normalizeTarget(t);
        if (DANGEROUS_TARGETS.has(t) || DANGEROUS_TARGETS.has(norm)) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * 检查整条命令行是否命中灾难操作规则
 */
export function isDisasterCommand(command: string): boolean {
  const subcommands = splitCommands(command);
  for (const sub of subcommands) {
    if (isDisasterSubcommand(sub)) {
      return true;
    }
  }
  return false;
}

/**
 * 检查该命令是否在当前任务的 approved.json 中
 */
export function isCommandApproved(taskDir: string | undefined, command: string): boolean {
  if (!taskDir) return false;
  const approvedPath = join(taskDir, "approved.json");
  if (!existsSync(approvedPath)) return false;
  try {
    const raw = readFileSync(approvedPath, "utf8");
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      const cmdTrimmed = command.trim();
      return data.some((item) => {
        if (typeof item === "string") return item.trim() === cmdTrimmed;
        if (item && typeof item.command === "string") return item.command.trim() === cmdTrimmed;
        return false;
      });
    }
  } catch {}
  return false;
}

export default function ompGuard(pi: ExtensionAPI) {
  if (process.env.OMP_GUARD === "off") {
    return;
  }

  pi.on("tool_call", async (event: ToolCallEvent, _ctx: unknown) => {
    if (event?.toolName !== "bash") return undefined;

    const command = event?.input?.command;
    if (typeof command !== "string" || !command.trim()) {
      return undefined;
    }

    const taskDir = process.env.OMP_TASK_DIR_CURRENT;

    // 1. 拦截前先查 approved.json，命令完全一致就放行
    if (isCommandApproved(taskDir, command)) {
      return undefined;
    }

    // 2. 检查是否命中灾难规则
    if (!isDisasterCommand(command)) {
      return undefined;
    }

    // 3. 命中高危操作，生成 short req id 并申请放行
    const req = Math.random().toString(36).slice(2, 10);
    const reason = `已请求用户放行（req=${req}），先跳过这一步继续做别的，不要换个写法绕过`;

    if (taskDir) {
      try {
        const approvalsPath = join(taskDir, "approvals.jsonl");
        const rec = {
          req,
          command,
          reason,
          ts: new Date().toISOString(),
        };
        appendFileSync(approvalsPath, `${JSON.stringify(rec)}\n`);
      } catch (err: any) {
        process.stderr.write(`[omp-guard] warning: failed to write approvals.jsonl: ${err?.message || err}\n`);
      }
    }

    process.stderr.write(`[omp-guard] blocked: ${reason} [command: ${command}]\n`);
    return { block: true, reason };
  });
}
