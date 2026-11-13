// tests/omp-guard.test.mjs — omp-guard 扩展单元测试
//
// Run with: node tests/omp-guard.test.mjs
// Node 22.18+ strips TypeScript types by default; on older 22.x use:
//   node --experimental-strip-types tests/omp-guard.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import guardExtension, {
  isCommandApproved,
  isDisasterCommand,
  tokenizeShell,
} from "../extensions/omp-guard.ts";

console.log("==> 开始 omp-guard 测试...");

let handler = null;
const mockPi = {
  on(event, fn) {
    if (event === "tool_call") {
      handler = fn;
    }
  },
};

guardExtension(mockPi);
assert.equal(typeof handler, "function", "tool_call handler 必须被成功注册");

const mockCtx = {
  cwd: process.cwd(),
  hasUI: false,
};

// 1. 灾难样例列表（必须被拦）
const disasterCases = [
  "rm -rf /",
  "rm -rf /*",
  "rm -r ~",
  "rm -R /home",
  "rm --recursive /var",
  "rm -rf $HOME",
  "rm -rf ${HOME}",
  "rm -rf /workspace",
  "rm -rf *",
  "rm -rf ..",
  "sudo rm -rf /etc",
  "rm --no-preserve-root -rf /",
  "find / -name '*.tmp' -delete",
  "find ~ -delete",
  "find $HOME -delete",
  "mkfs.ext4 /dev/sdb1",
  "dd if=/dev/zero of=/dev/sda",
  "echo ok && rm -rf /",
  "df -h; rm -rf /usr",
  "true || rm -rf /boot",
  "cat foo | rm -rf /opt",
];

for (const cmd of disasterCases) {
  const res = await handler({ toolName: "bash", input: { command: cmd } }, mockCtx);
  assert.ok(res && res.block === true, `灾难用例应被拦截: [${cmd}]`);
  assert.match(
    res.reason,
    /已请求用户放行（req=.*），先跳过这一步继续做别的，不要换个写法绕过/,
    `拦截提示语必须符合规范: [${cmd}]`,
  );
  console.log(`  ✓ 拦截灾难命令: ${cmd}`);
}

// 2. 正常删除和普通命令列表（一律放行）
const allowedCases = [
  "rm -rf ./build",
  "rm -rf node_modules",
  "rm -rf dist",
  "rm file.txt",
  "rm -f /tmp/test.txt",
  "find . -name '*.tmp' -delete",
  "find ./build -type f -delete",
  "find / -name '*.log'",
  "ls -la",
  "cat README.md",
  "git status",
  "git diff --stat",
  "dd if=/dev/urandom of=./test.bin count=1",
  "echo 'rm -rf /' # not executed",
  "printf '%s\\n' 'rm -rf /'",
];

for (const cmd of allowedCases) {
  const res = await handler({ toolName: "bash", input: { command: cmd } }, mockCtx);
  assert.equal(res, undefined, `正常命令应直接放行: [${cmd}]`);
  console.log(`  ✓ 放行普通命令: ${cmd}`);
}

// 非 bash 工具直接放行
for (const toolName of ["write", "edit", "read", "web_search"]) {
  const res = await handler({ toolName, input: { path: "/workspace/foo.txt" } }, mockCtx);
  assert.equal(res, undefined, `非 bash 工具直接放行: ${toolName}`);
}
console.log("  ✓ 非 bash 工具直接放行");

// 空命令/非字符串命令放行
assert.equal(await handler({ toolName: "bash", input: {} }, mockCtx), undefined);
assert.equal(await handler({ toolName: "bash", input: { command: "   " } }, mockCtx), undefined);
assert.equal(await handler({ toolName: "bash", input: { command: 42 } }, mockCtx), undefined);
console.log("  ✓ 空命令/非字符串命令放行");

// 3. approved.json 里的命令放行测试 & approvals.jsonl 写入测试
const testDir = mkdtempSync(join(tmpdir(), "omp-guard-test-"));
process.env.OMP_TASK_DIR_CURRENT = testDir;

try {
  // 未放行前，rm -rf /workspace 应被拦截，并向 approvals.jsonl 写入记录
  const blockRes = await handler({ toolName: "bash", input: { command: "rm -rf /workspace" } }, mockCtx);
  assert.ok(blockRes && blockRes.block === true, "未放行前应被拦截");

  const approvalsPath = join(testDir, "approvals.jsonl");
  const approvalsContent = readFileSync(approvalsPath, "utf8").trim();
  const recorded = JSON.parse(approvalsContent.split("\n")[0]);
  assert.equal(recorded.command, "rm -rf /workspace");
  assert.ok(recorded.req && typeof recorded.req === "string");
  assert.ok(recorded.ts && typeof recorded.ts === "string");
  assert.match(blockRes.reason, new RegExp(`req=${recorded.req}`));
  console.log(`  ✓ 拦下后成功追加到 approvals.jsonl: req=${recorded.req}`);

  // 将灾难命令写入 approved.json
  writeFileSync(join(testDir, "approved.json"), JSON.stringify(["rm -rf /workspace"]) + "\n");

  // 写入 approved.json 后，再次执行相同命令必须放行
  const approvedRes = await handler({ toolName: "bash", input: { command: "rm -rf /workspace" } }, mockCtx);
  assert.equal(approvedRes, undefined, "approved.json 里的命令必须放行");
  console.log("  ✓ approved.json 里的命令放行成功: rm -rf /workspace");

  // 空白差异不算完全一致（安全侧：仍然拦截）
  const differentRes = await handler({ toolName: "bash", input: { command: "rm  -rf /workspace" } }, mockCtx);
  assert.ok(differentRes && differentRes.block === true, "非完全一致的命令仍应拦截");
  console.log("  ✓ 非完全一致命令仍拦截");

  // 直接测试导出函数
  assert.equal(isCommandApproved(testDir, "rm -rf /workspace"), true);
  assert.equal(isCommandApproved(testDir, "rm -rf /etc"), false);
  assert.deepEqual(tokenizeShell("echo 'a b' c"), ["echo", "a b", "c"]);
  assert.equal(isDisasterCommand("rm -rf /"), true);
  assert.equal(isDisasterCommand("rm -rf ./build"), false);
  console.log("  ✓ 导出函数行为正确");
} finally {
  delete process.env.OMP_TASK_DIR_CURRENT;
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {}
}

// 4. 没有任务目录时仍拦截（写盘失败不影响 block）
delete process.env.OMP_TASK_DIR_CURRENT;
const noDirRes = await handler({ toolName: "bash", input: { command: "rm -rf /" } }, mockCtx);
assert.ok(noDirRes && noDirRes.block === true, "无任务目录时仍应拦截");
console.log("  ✓ 无 OMP_TASK_DIR_CURRENT 时仍拦截");

// 5. OMP_GUARD=off 测试
process.env.OMP_GUARD = "off";
let offHandler = null;
const offMockPi = {
  on(event, fn) {
    if (event === "tool_call") offHandler = fn;
  },
};
guardExtension(offMockPi);
assert.equal(offHandler, null, "OMP_GUARD=off 时扩展不应注册或生效");
delete process.env.OMP_GUARD;
console.log("  ✓ OMP_GUARD=off 时扩展已正确旁路");

console.log("\n✅ omp-guard 测试全部通过！");
