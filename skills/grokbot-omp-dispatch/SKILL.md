---
name: grokbot-omp-dispatch
description: Grok Bot 要做超过两三步的执行活（写代码、改文件、扫目录、整理或生成内容）时，开干前读这个：Bot 只写任务书、用 omp-task 后台派给电脑上的 OMP、跑完或被 webhook 叫醒后验收并确认。还没装好先看 grokbot-omp-setup。
---

# grokbot-omp-dispatch：Bot 写任务，OMP 干活，Bot 验收

Bot 只做三件事：写任务、派给 OMP、验收。一两步的小事 Bot 自己做，别派。
派活用 `omp-task`：每个任务有 ID、状态目录和派活的 Bot（owner），跑完发通知，验收完 ack，不漏报也不报别人的任务。

## 0. 自己的 owner ID
Bot 的 agent id，通常在 `/home/box/agent-data/agents/<ID>/profile.json` 的目录名里。派活、reply、pending、ack、approve、deny 都带 `--owner <ID>`。

## 1. 写任务书（越短越好）
只写五件事：
1. **做什么**：一两句讲清目标与必要背景。**OMP 看不到聊天上下文**。
2. **产物路径**：改哪个文件、生成到哪个绝对路径。
3. **怎么算做完**：可检查的标准（测试通过、文件内容正确、导出了哪个函数）。
4. **严格边界**：「只改 <目录>，不要删除任何文件，不要 git push」。
5. **收尾**：「写完产物自查一次就结束，不要反复自查或重试」。

## 2. 后台派活
用 Bot 自己的 Shell 工具**后台**运行（不阻塞等待；不要用 `nohup`、`&`、`setsid`）：

```bash
~/tools/omp-call/omp-task run <工作目录> '<任务书>' --session <短名> --owner <ID> --notify-prefix <BOT> \
  [--model <provider/model>] [--thinking medium] [--timeout 1800]
```

- `--notify-prefix <BOT>` 会自动从 `<BOT>_OMP_NOTIFY_URL` 与 `<BOT>_OMP_NOTIFY_KEY` 读取通知配置；同机多个 Bot 各用各的 webhook，无需手动传 secret。
- 模型可选：省略 `--model` 时优先读取 `OMP_TASK_MODEL`，两者皆无时直接采用 OMP 配置的默认模型与额度。
- 工作目录选最小的（项目目录或 `/tmp/<名>`），不要 `/` 或整个 home。
- 只读的活加 `--no-write`；不需要联网加 `--no-web`；难活才 `--thinking high`。
- 追加要求用 `omp-task reply <ID> '<补充>' --owner <ID>`，校验 owner 并沿用同一 OMP 会话与目录。
- 被宿主机重启打断（`interrupted`）时：先 `omp-task cancel <ID>` 清掉旧状态（提示 not running 就跳过），再 `omp-task reply <ID> '电脑重启打断了你，接着做剩下的…' --owner <ID>`；已经做好的不要重做。

## 3. 本轮等待（强制）
派完告诉用户「已派出」，然后**不要结束当前轮**：

1. 宿主机在 Bot 空闲时会睡眠甚至重启，后台 OMP 会被冻住或杀掉。
2. 用一次长时间阻塞的 `AwaitShell`（单次最长约 13 分钟，**不要轮询、不要 sleep**）等这个后台 Shell 跑完，跑完立刻验收。挂着等基本不耗 Bot 额度。
3. 一次等不完就再等一次；用户插话时先回复，再接着等。
4. Webhook 只是兜底：万一这一轮还是结束了，它会把 Bot 单独叫醒。
5. 电脑睡醒是常态：刚醒时网关链路（如 Tailscale）可能端口通但请求挂住，2 分钟后报 `UND_ERR_SOCKET`。配了 `omp-preflight` 时 `omp-task` 会在 run/reply/approve/deny 前先测通路、不健康就重连并等它恢复；没配就自己先测一次网关健康接口再派。遇到这类连接错误，先测通路再 reply 续跑，别直接重试。

## 4. 等结果与审批放行
- **正常完成**：`omp-task` 结束时 POST `{source:"omp-task",id,owner,state,exit_code}` 到 webhook，例行任务把 Bot 单独叫醒。醒来先跑：
  ```bash
  ~/tools/omp-call/omp-task pending --owner <ID>
  ```
- **看进度**：`omp-task status <ID>`、`omp-task log <ID> -n 20`；取消：`omp-task cancel <ID>`。
- **审批放行（needs_approval）**：若 OMP 触发高危命令保护被 `omp-guard` 拦截，Webhook 会推送 `state: "needs_approval"`、`req` 和 `command`：
  1. Bot 必须把 `command` **原样**展示给用户，说明已被拦截，询问是否授权放行；
  2. 用户明确同意：`omp-task approve <ID> <req> --owner <ID>`；
  3. 用户明确拒绝：`omp-task deny <ID> <req> --owner <ID>`；
  4. **铁律：Bot 自己永远不能替用户授权放行。**
- **磁盘是唯一事实来源**：`~/.omp/tasks/<ID>/` 才是真相；漏了通知不要重跑，用 `pending` 找回。

## 5. 验收并确认
1. 读 `~/.omp/tasks/<ID>/result.md`，再**亲自**检查产物、diff 或测试。OMP 的回复只是声称，不算证据。
2. 回报用户：ID、状态、结论、验收证据、产物绝对路径。
3. `omp-task ack <ID> --owner <ID>`。
4. 验收不过就不 ack，用 `omp-task reply <ID> '<补充说明>' --owner <ID>` 补充说明重派，最多两次；失败或超时先问用户要不要重试。
5. 失败 / 超时 / `interrupted`：**不要自动盲目重跑**。先向用户说明根因，问是否重试；`interrupted` 则 cancel（如需）+ `reply` 续跑。

## 6. 铁律
- 删除、发送消息或邮件、付款、发帖、`git push`、部署生产，**永远不交给 OMP**；由 Bot 在用户单独确认后自己做。
- 审批放行必须由用户决断，Bot 严禁擅自 `approve`。
- `omp-guard` 默认开启；任务书仍应明确限定目录、禁止删除。
- 不读、不打印密钥，也不读 `~/.omp/agent/` 下的凭据库/模型凭据。
- 别的 Bot 的任务不看、不报、不 ack；永远带 `--owner` 过滤。
- 回复语言跟随用户偏好。
