# 🚚 grokbot-omp-dispatch

Grok Bot 的通用派活方法：**Bot 写任务书 → `omp-task` 后台派给 OMP → 本轮阻塞等待 → 跑完验收（或 Webhook 兜底叫醒）并 ack**。任务有 ID、状态和归属 Bot（owner），不漏报、不串台。

**任务书只写五件事**：做什么、产物路径、完成标准、边界（限定目录、禁止删除）、自查一次就结束。

**适合谁**：已经按 [grokbot-omp-setup](../grokbot-omp-setup/README.md) 运行 `./install.sh` 装好工具、配好 OMP 与唤醒 webhook 的 Grok Bot。

**安装**
```bash
npx skills add yuehen7/grokbot-and-omp --skill grokbot-omp-dispatch --global --yes
```

**触发**：Bot 遇到超过两三步的执行活时自动读；也可以说「派给 OMP」「让 OMP 来做」「按 grokbot-omp-dispatch 派活」。

派活示例：
```bash
~/tools/omp-call/omp-task run <工作目录> '<任务书>' --session <短名> --owner <ID> --notify-prefix <BOT> [--model <provider/model>]
```

⚠️ 删除、发送、付款、发帖、`git push` 永远不交给 OMP。`needs_approval` 必须把命令原样给用户看，**严禁擅自 `approve`**；不读不打印通知密钥与 `~/.omp/agent/` 凭据。
