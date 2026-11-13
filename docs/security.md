# 安全防护机制与放行流程 (Security & Guard)

GAO (Grokbot And Omp) 架构面向 AI Agent 自动化调度，其中 OMP 具备在宿主环境中执行 Shell 命令的能力。为了避免 LLM 偶发幻觉导致极其严重的系统性破坏，系统内置了轻量级防护扩展 `omp-guard`。

---

## 1. omp-guard 的防护范围与设计原则

`omp-guard` 的设计原则是**只防灾难性删除或抹盘，范围极窄，不加其他繁复规则**，规则集与 GAP 的 `pi-guard` 保持一致：

- **拦截的高危操作**：
  1. `rm` 带有递归参数（`-r`、`-R` 或 `--recursive`），且删除目标为系统关键目录、工作区、上级目录或通配符，包括：`/`、`/*`、`~`、`~/`、`$HOME`、`${HOME}`、`/home`、`/root`、`/etc`、`/usr`、`/var`、`/boot`、`/opt`、`/bin`、`/lib`、`/workspace`、`..`、`*`（无论是否带 `--no-preserve-root`）。
  2. `find` 从根目录或用户主目录出发（`/`、`~`、`~/`、`$HOME`、`${HOME}`）并带有 `-delete` 参数。
  3. 磁盘格式化命令 `mkfs`（如 `mkfs.ext4`）。
  4. 底层块设备覆写 `dd` 写入目标为设备文件（`of=/dev/...`）。
- **完全放行的常规操作**：
  - 项目日常构建产物与依赖删除（如 `rm -rf ./build`、`rm -rf node_modules`、`rm -rf dist`、`rm file.txt`、`rm -f /tmp/test.txt` 等）一律放行。
  - 常规非破坏性命令（`ls`、`cat`、`git status`、`find . -name "*.log" -delete` 等）一律放行。

`omp-guard` 通过 OMP 的扩展 `tool_call` 钩子生效。`omp-task` 在启动 OMP 时显式传入：

```text
omp --mode rpc ... -e ~/tools/omp-call/extensions/omp-guard.ts
```

`OMP_GUARD=off` 或 `omp-task run/... --guard off` 可整体旁路。

> 注意：`omp-task` 刻意不启用 OMP 的 `eval` 与 `task`（subagent）工具，因为 `eval` 可绕过 bash 规则、子 agent 也可能脱离本任务的审批闭环。只读任务使用 `read,glob,grep`，写任务使用 `read,bash,edit,write,glob,grep,todo,wait`。

---

## 2. 审批与放行流程 (Approval Workflow)

当 OMP 尝试执行被 `omp-guard` 识别为灾难性的操作时，系统不会直接将任务宣告失败，而是进入闭环审批流程：

```
[OMP 尝试执行危险命令]
       │
       ▼
[omp-guard 拦截] ──写入──> $OMP_TASK_DIR_CURRENT/approvals.jsonl
       │                 (生成短随机 req ID，通知 OMP 先跳过继续做别的)
       ▼
[omp-task 实时感知] ─────> Webhook 触发 (state: "needs_approval", req, command)
       │
       ▼
[宿主 Bot 醒来] ────────> 将命令原样展示给用户并询问放行意见
       │                 (⚠️ 铁律：Bot 绝不自行审批)
       ├─────────────────────────────────┐
       ▼ [用户同意]                       ▼ [用户拒绝]
~/tools/omp-call/omp-task approve <ID> <req>   ~/tools/omp-call/omp-task deny <ID> <req>
       │                                         │
 写入 approved.json 并续跑 OMP               告知 OMP 该操作被拒，换不删除的做法或跳过
 (命令完全一致即予放行)
```

1. **拦截并记录**：
   `omp-guard` 拦截命令，在当前任务目录下向 `approvals.jsonl` 追加一条记录 `{req, command, reason, ts}`。返回给 OMP 的 reason 明确说明：「已请求用户放行（req=<id>），先跳过这一步继续做别的，不要换个写法绕过」。
2. **Webhook 唤醒**：
   `omp-task` 在后台监控到新的审批请求后，立刻向宿主 Bot 发送一次 Webhook 通知：
   ```json
   {
     "source": "omp-task",
     "id": "<TASK_ID>",
     "owner": "<BOT_ID>",
     "state": "needs_approval",
     "exit_code": null,
     "req": "<REQ_ID>",
     "command": "<DANGEROUS_COMMAND>"
   }
   ```
   **注意**：此时任务本身并不结束，仍在继续执行其他无需放行的工作，直到整轮结束。
3. **用户裁决**：
   Bot 收到 `needs_approval` 后，**必须把命令原样发给用户**，询问用户是否授权放行。**Bot 自身永远不得擅自放行！**
4. **执行 approve 或 deny**：
   - 若用户确认同意：Bot 运行 `omp-task approve <ID> <req> [--owner <id>]`。该命令将目标命令原样写入本任务的 `approved.json` 白名单，并给 OMP 发送放行提示续跑同一会话。当 OMP 再次执行该**完全一致**的命令时，`omp-guard` 查白名单直接放行。
   - 若用户拒绝：Bot 运行 `omp-task deny <ID> <req> [--owner <id>]`，通知 OMP 该操作被拒绝，促使 OMP 寻找替代方案或跳过。

---

## 3. 防护边界与局限性说明

### 防君子不防小人
`omp-guard` 是一个位于 OMP 工具层（`tool_call` 事件）的轻量级拦截器：
- 它的定位是**防止 LLM 在自主编写命令时出现严重失误或通配符误写（如 `rm -rf /` 或手滑删了整个 `/workspace`）**。
- **它无法防御有意的恶意绕过**：例如，如果任务或恶意代码通过写入 Python/Node/Shell 脚本并随后执行该脚本来递归删除，或者通过 Base64 编码间接执行 Shell，`omp-guard` 无法从 AST 层面深挖间接执行的删除。
- 同理，OMP 的 `eval` 工具、子 agent、MCP 工具与自定义工具都可能绕开仅针对 `bash` 的规则，因此任务工具集刻意不启用 `eval`/`task`；但这仍不是权限沙箱。
- 规则只匹配**命令字符串**；路径经变量展开、符号链接、`--` 之后的参数等仍可能产生语义偏差。

### 强隔离需求：使用 Sandbox 扩展
如果业务场景需要抵御恶意代码执行或实现强宿主隔离，单靠命令过滤是不够的。应使用 OMP 官方 sandbox 扩展或外部隔离方案：
- 通过 Docker 容器、轻量虚拟机（如 MicroVM / Firecracker）或 Bubblewrap / nsjail 等 Linux 命名空间技术，将 OMP 及其执行的所有命令完全限制在隔离沙盒内；
- 沙盒内即便执行抹盘也仅破坏临时容器实例，无法影响宿主系统与主工作区。

---

## 4. 永不派给 OMP 的操作

以下操作必须由 Grok Bot 在用户单独确认后**亲自执行**，不得写进派给 OMP 的任务书：

- 删除重要文件或目录；
- 发送消息、邮件或任何对外通信；
- 付款、下单、转账；
- 公开发帖、发布内容；
- `git push`、合并/发布分支；
- 部署到生产环境；
- 读取或导出任何密钥、OAuth 凭据、`~/.omp/agent/` 下的认证数据库。

---

## 5. 密钥卫生

- 通知密钥（`<BOT>_OMP_NOTIFY_URL`、`<BOT>_OMP_NOTIFY_KEY`、`OMP_NOTIFY_SECRET`）只通过 Secret 卡/环境变量注入；不进仓库、不进聊天、不进任务文件。
- `omp-task` 启动 OMP 子进程前会剥离 `OMP_NOTIFY_URL`、`OMP_NOTIFY_SECRET`、`__OMP_NOTIFY_SECRET`、所有 `*_OMP_NOTIFY_URL` / `*_OMP_NOTIFY_KEY` 变量；独立 notifier 才拿得到 Bearer key。
- 通知 payload 只含 `source/id/owner/state/exit_code`（审批时加 `req/command`），不含 prompt、result 或密钥。
- OMP 的凭据库（`~/.omp/agent/` 下的数据库与 `models.yml` 中的 key 引用）禁止 Bot 或子 agent 读取、打印、复制。
- 任务事件里的命令/路径文本会单行化并截断到 500 字符；不要把密钥写进 prompt。

---

## 6. 工作目录最小化

- 派活 cwd 选项目目录或 `/tmp/<名>`，禁止 `/`、整个 `$HOME` 或 `/workspace` 根。
- 任务书明确「只改 <目录>，不要删除任何文件，不要 git push」。
- 只读任务加 `--no-write`；不需要联网加 `--no-web`。
- `--no-write` 不是沙箱：OMP 仍可能通过其他已启用工具产生副作用，边界主要靠任务书与目录选择。
