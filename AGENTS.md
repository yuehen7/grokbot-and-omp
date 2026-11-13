# AGENTS.md — GAO (Grokbot And Omp) 配置向导

> 本文档专门写给 **Grok Bot（AI Agent）**。  
> 当用户将本仓库链接发给你时，请按照本文档的 7 个步骤依序自行配置完成。  
> 每一项明确了操作步骤、完成标准，以及**必须由用户操作**的边界。

GAO 的目标：Grok Bot 只做规划与验收；真正读写文件、跑命令的重活交给同机 **OMP**（[omp.sh](https://omp.sh)），消耗用户自己的模型额度。

---

## 步骤 1：检查并安装 OMP

### Agent 执行
1. 检查 Node.js 版本（`omp-task` / `omp-call` 包装脚本必须 `>= 22`）：
   ```bash
   node -v
   ```
2. 检查 `omp` 命令是否已安装：
   ```bash
   command -v omp && omp --version
   ```
3. 若未安装，按 OMP 官方方式安装：
   ```bash
   curl -fsSL https://omp.sh/install | sh
   ```
4. 重新验证：
   ```bash
   omp --version
   ```

### 判定完成标准
- `node -v` 主版本号 `>= 22`。
- `omp --version` 正常输出版本号、退出码为 0（本项目以 `omp >= 18.18.9` 验证）。

---

## 步骤 2：配置模型与额度

### 必须由用户做的事
- **确定额度来源**（详情见 [docs/quota.md](docs/quota.md)）：
  - 选项 A：官方 API Key、OAuth 登录或 OpenAI 兼容中转站；
  - 选项 B：VPS 上通过 Tailscale 内网运行的 Magpie 等转换网关；
  - 选项 C：OMP 本机已配置好默认模型，直接沿用。

OMP 的 OAuth 登录是交互式的：让用户在终端运行 `omp`，输入 `/login`，按提示在浏览器完成授权。**不要**让用户把 API Key、OAuth code 或网关 Token 贴在聊天里。

### Agent 执行
在获得用户配置或默认授权后，跑最小无会话探活：
```bash
omp -p 'Reply with only OK' --no-session
# 或指定 provider/model：
omp -p 'Reply with only OK' --no-session --model <provider/model>
```

### 判定完成标准
- 命令输出包含 `OK`，退出码为 0。
- 若走网关，建议顺手配置 `omp-preflight`（步骤 3 之后），避免宿主机睡醒后链路假死。

---

## 步骤 3：克隆仓库并安装脚本

### Agent 执行
```bash
git clone https://github.com/yuehen7/grokbot-and-omp /tmp/grokbot-and-omp
cd /tmp/grokbot-and-omp
./install.sh
```

### 判定完成标准
- `~/tools/omp-call/` 下存在 `omp-task`、`omp-task.mjs`、`omp-call.mjs`、`omp-run`，且入口具备可执行权限。
- `extensions/omp-guard.ts` 已同步安装，guard 默认开启。
- `~/tools/omp-call/omp-task --help` 正常打印使用指南。
- （可选）网关场景：
  ```bash
  cp ~/tools/omp-call/omp-preflight.example ~/tools/omp-call/omp-preflight
  chmod +x ~/tools/omp-call/omp-preflight
  ```
  然后按文件内注释改好健康检查 URL 与 Tailscale/转发脚本路径；`omp-task` 会在 run/reply/approve/deny 前自动执行。

---

## 步骤 4：创建 Webhook 唤醒例行任务（Routine）

### Agent 与用户协作
1. 参考 [routines/omp-task-notify.md](routines/omp-task-notify.md)。
2. 获取当前 Bot 的 Agent ID（通常从 profile 路径读取，例如 `/home/box/agent-data/agents/<BOT_ID>/profile.json` 的目录名）。
3. **在 Grok Bot 平台的 Routines 界面创建例行任务**：
   - 触发方式：**Webhook**。
   - 任务名称：如 `OMP 任务完成唤醒`。
   - 提示词：把 `routines/omp-task-notify.md` 中「例行任务提示词」完整填入，将 `<BOT_ID>` 替换为真实 Agent ID。

### 判定完成标准
- Routine 创建并启用，生成 Webhook URL 与认证 Bearer Token。

---

## 步骤 5：录入 Webhook 密钥（必须由用户完成）

### ⚠️ 铁律安全要求
- **严禁**让用户在普通聊天窗口明文发送 URL 和 Secret。
- **严禁**把 Webhook 密钥写入仓库、脚本或任务文件。
- 必须引导用户使用平台的 **Secret Card / 安全环境变量** 录入：
  - `<BOT>_OMP_NOTIFY_URL`：步骤 4 生成的 Webhook 地址；
  - `<BOT>_OMP_NOTIFY_KEY`：步骤 4 生成的 Bearer Token。
  （`<BOT>` 是当前 Bot 的大写前缀，例如 `GROKBOT`。）

### Agent 验证
只检查变量是否存在，不打印值：
```bash
[ -n "${GROKBOT_OMP_NOTIFY_URL:-}" ] && [ -n "${GROKBOT_OMP_NOTIFY_KEY:-}" ] && echo "Configured"
```

### 判定完成标准
- 环境变量已安全注入，聊天与日志中没有出现具体密钥。

---

## 步骤 6：加载 Grok Bot 技能（Skills）

### Agent 执行
将本仓库两个 Skill 存入当前 Bot 的技能系统：
1. `skills/grokbot-omp-setup/SKILL.md`：首次配置与自检。
2. `skills/grokbot-omp-dispatch/SKILL.md`：日常写任务书、后台派活、验收。

### 判定完成标准
- 两个 `SKILL.md` 已被加载；Bot 能理解「派活给 OMP」「按 grokbot-omp-dispatch 派活」的意图与规则。

---

## 步骤 7：端到端闭环冒烟测试

### Agent 执行
1. **后台派发最小任务**（必须用 Shell 工具的后台模式，不要 `nohup`/`&`/`setsid`）：
   ```bash
   ~/tools/omp-call/omp-task run /tmp \
     "在 /tmp/gao-smoke.txt 中写入 gao-ok 并自查结束" \
     --session smoke-gao --owner <BOT_ID> --notify-prefix <BOT>
   ```
2. 告知用户已派发，**不要结束当前轮**；用一次长时间阻塞的 `AwaitShell`（单次约 13 分钟上限）等它结束。宿主机在 Bot 空闲时会睡眠，Webhook 只是兜底。
3. 醒来后先查自己的未报告任务：
   ```bash
   ~/tools/omp-call/omp-task pending --owner <BOT_ID>
   ```
4. 读取状态与结果：
   ```bash
   ~/tools/omp-call/omp-task status <TASK_ID>
   cat ~/.omp/tasks/<TASK_ID>/result.md
   ```
5. **亲自核验产物**（OMP 的回复只是声称）：
   ```bash
   cat /tmp/gao-smoke.txt   # 必须为 gao-ok
   ```
6. 核验通过后确认：
   ```bash
   ~/tools/omp-call/omp-task ack <TASK_ID> --owner <BOT_ID>
   ```
7. 验证 pending 已清空：
   ```bash
   ~/tools/omp-call/omp-task pending --owner <BOT_ID>   # 输出应为空
   ```

### 判定完成标准
- Bot 等待任务完成或被 Webhook 独立唤醒；
- `/tmp/gao-smoke.txt` 内容确实为 `gao-ok`；
- `ack` 后 `pending --owner <BOT_ID>` 输出为空；
- 全链路闭环验证通过。

---

## 排障提示

- 若 `omp` 不在 PATH：重新打开 shell，或把安装器提示的目录加入 PATH。
- 若模型探活失败：检查 OMP provider 配置（`~/.omp/agent/models.yml`）、登录状态与网络；不要让 Bot 读取/打印凭据库。
- 若任务一直 `running` 但进程已不存在：运行 `omp-task list` 会触发孤儿检测并标记 `interrupted`，再用 `omp-task reply` 续跑。
- 若同一 `--session` 已有 running 任务：先 `status`/`cancel`，或换 session。
- 若网关睡醒后请求挂住：配置 `omp-preflight`；没有配置就先手动测网关健康接口。
