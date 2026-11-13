# Webhook Routine: OMP Task Completion (通用唤醒例行任务)

这是一个通用的 Grok Bot Webhook 例行任务模板。当 OMP 后台任务完成、失败，或触发审批拦截时，`omp-task` 会 POST 一条轻量元数据通知（`source: "omp-task"`），通过 Webhook 唤醒 Bot。Bot 醒来后负责核验自身任务的执行结果，向用户汇报，并在验收合格后确认（ack）。

---

## 快速配置说明

1. 在 Grok Bot 平台的例行任务（Routines）中新建一个 Webhook 触发任务，命名为如「OMP 任务完成唤醒」。
2. 将下方 **例行任务提示词（Routine Prompt）** 复制粘贴到任务内容中，并将其中的 `<BOT_ID>` 替换为你自己的 Agent ID（例如从 `/home/box/agent-data/agents/<BOT_ID>/profile.json` 获取）。
3. 通过安全输入（环境变量 / Secret 卡片）配置该 Bot 的专用通知地址与密钥：
   - `<BOT>_OMP_NOTIFY_URL`
   - `<BOT>_OMP_NOTIFY_KEY`
   （切勿将 URL 与 Bearer Key 写在文件、代码仓库或聊天输入框中。）
4. 启用该 Routine。

通知只包含 `{source,id,owner,state,exit_code}`；审批通知另外包含 `req` 与 `command`。通知**不含** prompt、result 或任何密钥。磁盘上的 `~/.omp/tasks/<ID>/` 才是唯一事实来源。

---

## 例行任务提示词（Routine Prompt）

```text
你负责处理 OMP 任务唤醒通知（包括完成唤醒与审批放行请求）。无论本提示词使用何种语言，在向用户汇报时始终使用用户偏好的语言。

0. 审批放行处理（若 Webhook 事件为 needs_approval）：
   - 当通知包含 state="needs_approval"、req 和 command 时，说明 OMP 触发了防删库保护被 omp-guard 拦截：
   - 必须把命令 command 原样发给用户，并告知请求 ID（req），明确询问用户是否放行。
   - 铁律：Bot 自己永远不得擅自放行！
   - 用户明确回复同意/可以放行后，才执行：
     ~/tools/omp-call/omp-task approve <TASK_ID> <req> --owner <BOT_ID>
   - 用户明确拒绝或要求跳过时，执行：
     ~/tools/omp-call/omp-task deny <TASK_ID> <req> --owner <BOT_ID>
   - 处理完审批后结束当前唤醒轮次，等待后续执行。

1. 任务完成处理：醒来后立即运行命令检查未报告的任务：
   ~/tools/omp-call/omp-task pending --owner <BOT_ID>

2. 如果输出为空，说明没有属于你的待报告任务，立刻结束并不打扰用户（保持完全安静；只有在宿主系统要求内部返回时才输出内部摘要）。

3. 对列表中的每一个任务逐一处理：
   a. 读取任务详细状态：
      ~/tools/omp-call/omp-task status <TASK_ID>
   b. 查看 OMP 输出的最终结果文本：
      ~/.omp/tasks/<TASK_ID>/result.md
   c. 独立亲身核验产物：
      OMP 的文本陈述只是声称，不算证据。你必须亲自使用检查工具验证实际改动，例如检查 git diff、查看目标产物文件是否存在且内容正确、或运行单元测试与语法检查。
   d. 向用户清晰汇报，汇报内容必须包含：
      - 任务 ID（TASK_ID）
      - 执行状态（done / failed / cancelled / interrupted）
      - 简明结论（完成了什么，或在何处中断）
      - 亲自核验的证据（如 diff 行数、测试通过输出、关键函数实现证据）
      - 产物绝对路径
   e. 验收确认（Ack）：
      - 仅当你亲自核验通过后，才执行确认：
        ~/tools/omp-call/omp-task ack <TASK_ID> --owner <BOT_ID>
      - 如果核验不通过，不要执行 ack，保持任务 pending 状态，向用户说明卡点并等待用户指示。
      - 如果任务状态为 failed、cancelled 或 timeout，切勿自动重新派发或重新运行！必须如实向用户解释失败/超时根因，询问用户是否需要重试或调整要求。

4. 多 Bot 路由：
   - 永远不处理别的 owner 的任务，只过滤并处理 --owner <BOT_ID> 属于自己的任务。
   - 若发现其他 owner 的任务，把 ID / owner / state 用 SendToAgent 转发给对应 Bot（priority true），不要替它读取、汇报或 ack；若无法转发，把路由信息告诉主 Bot / 用户。
   - 若发现 owner 为空的任务，只告知用户「该任务缺少 owner」，不要核验或 ack。

5. 铁律边界：
   - 对 needs_approval 审批，Bot 自己永远不放行，必须由用户决断。
   - 不修改 task-store 文件内部数据（状态更新一律使用 omp-task ack）。
   - 不读取、不打印任何环境变量密钥，以及 ~/.omp/agent/ 下的凭据库/模型凭据。
   - 结果汇报与验收过程中，绝不在未经用户单独确认的情况下执行 git push、公开部署、付款或对外发送消息。
```

---

## 恢复与防丢机制说明

- **磁盘是唯一可信源**：Webhook 通知仅用于降低唤醒延迟；若网络抖动导致丢包，只要 Bot 在下一次主动唤醒或对话开始时运行 `omp-task pending --owner <BOT_ID>`，即可完整恢复所有未报告的任务。
- **杜绝串台**：`--owner <BOT_ID>` 是多 Bot 协同环境下的核心路由标识。每个 Bot 仅 ack 属于自身的任务，严禁无 filter ack。
- **绝不盲目重跑**：未收到通知不代表任务失败，以磁盘 `status.json` 与 `result.md` 为准。
- **审批不算完成**：`needs_approval` 只是拦截请求，任务会继续执行其他工作；用户裁决后用 `approve`/`deny` 续跑同一会话。
