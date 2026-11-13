#!/usr/bin/env bash
# install.sh — 安装 grokbot-and-omp 工具脚本
#
# 检查 Node >= 22 和 omp 命令，将 bin/ 与 extensions/ 复制到
# ${OMP_TASK_HOME:-$HOME/tools/omp-call}。脚本绝不执行任何删除操作。

set -euo pipefail

echo "==> 检查系统依赖环境..."

# 1. 检查 node（omp-task.mjs / omp-call.mjs 需要 Node >= 22）
if ! command -v node >/dev/null 2>&1; then
  echo "错误：未检测到 'node' 命令。" >&2
  echo "grokbot-and-omp 的包装脚本需要 Node.js >= 22，请先安装 Node.js（https://nodejs.org/）。" >&2
  exit 1
fi

NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "错误：当前 Node.js 版本为 $(node -v)，但需要 Node.js >= 22。" >&2
  echo "请升级 Node.js 后重试（例如使用 nvm、fnm 或包管理器）。" >&2
  exit 1
fi
echo "  ✓ Node.js $(node -v) 符合要求"

# 2. 检查 omp
if ! command -v omp >/dev/null 2>&1; then
  echo "错误：未在 PATH 中找到 'omp' 命令。" >&2
  echo "请先安装 OMP（https://omp.sh）：" >&2
  echo "  curl -fsSL https://omp.sh/install | sh" >&2
  exit 1
fi
echo "  ✓ 检测到 omp 命令: $(command -v omp) ($(omp --version 2>/dev/null | head -1))"

# 本项目以 OMP >= 18.18.9 验证（prompt_result / negotiate_protocol / get_state /
# extension tool_call）。旧版本可能缺少 RPC 帧；这里只警告，不阻断安装。
MIN_OMP_VERSION="18.18.9"
OMP_VERSION=$(omp --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
if [ -n "$OMP_VERSION" ]; then
  if ! node -e '
    const [a,b,c] = process.argv[1].split(".").map(Number);
    const [x,y,z] = process.argv[2].split(".").map(Number);
    process.exit(a > x || (a === x && (b > y || (b === y && c >= z))) ? 0 : 1);
  ' "$OMP_VERSION" "$MIN_OMP_VERSION"; then
    echo "  ⚠ 警告：检测到 omp $OMP_VERSION，低于验证版本 $MIN_OMP_VERSION。" >&2
    echo "    建议升级 OMP；旧版本可能缺少 prompt_result/negotiate_protocol 等 RPC 能力。" >&2
  fi
fi

# 3. 复制 bin/ 与 extensions/ 到目标目录（不删除已有文件）
TARGET_DIR="${OMP_TASK_HOME:-$HOME/tools/omp-call}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> 安装脚本至: $TARGET_DIR"
mkdir -p "$TARGET_DIR"

cp -p "$SCRIPT_DIR/bin/"* "$TARGET_DIR/"
chmod +x "$TARGET_DIR/omp-task" "$TARGET_DIR/omp-task.mjs" "$TARGET_DIR/omp-call.mjs" "$TARGET_DIR/omp-run"

if [ -d "$SCRIPT_DIR/extensions" ]; then
  mkdir -p "$TARGET_DIR/extensions"
  cp -p "$SCRIPT_DIR/extensions/"* "$TARGET_DIR/extensions/"
  echo "  ✓ 已复制扩展: extensions/omp-guard.ts"
fi

echo "  ✓ 已复制并配置可执行权限: omp-task, omp-task.mjs, omp-call.mjs, omp-run"

# 4. 打印后续指引
echo ""
echo "=========================================="
echo "✅ 安装成功！已就绪于: $TARGET_DIR"
echo "=========================================="
echo ""
echo "下一步操作建议："
echo ""
echo "1. 将工具目录加入 PATH（可在 ~/.bashrc 或 shell 配置中持久化）："
echo "   export PATH=\"$TARGET_DIR:\$PATH\""
echo ""
echo "2. 运行冒烟测试（关闭通知，快速验证执行与追踪）："
echo "   OMP_NOTIFY_OFF=1 \"$TARGET_DIR/omp-task\" run /tmp 'Reply with only OK' --session smoke --owner smoke-test"
echo "   # 观察输出包含 STATE done 后确认该任务："
echo "   \"$TARGET_DIR/omp-task\" ack smoke-... --owner smoke-test"
echo ""
echo "3. 为 Grok Bot 配置 Webhook 唤醒例行任务："
echo "   参考 routines/omp-task-notify.md 在 Bot 平台创建例行任务，并安全配置环境变量："
echo "   <BOT>_OMP_NOTIFY_URL 和 <BOT>_OMP_NOTIFY_KEY"
echo ""
echo "4. 在 Grok Bot 中加载对应技能："
echo "   - skills/grokbot-omp-setup   : 初始化环境与连通性验证"
echo "   - skills/grokbot-omp-dispatch: 自动派活、监控与验收确认"
echo ""
echo "5. 可选：配置模型通路预检（宿主机睡眠醒来后自动重连）"
echo "   cp \"$TARGET_DIR/omp-preflight.example\" \"$TARGET_DIR/omp-preflight\""
echo "   然后按文件内注释改好健康检查 URL 与 Tailscale/转发脚本路径。"
echo ""
