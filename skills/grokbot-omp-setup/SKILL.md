---
name: grokbot-omp-setup
description: 第一次让 Grok Bot 把执行活派给电脑上的 OMP 之前用：在 Bot 的电脑上装 OMP（omp.sh）、给 OMP 接一个模型（任意 API key、OAuth、中转站、网关或自带默认模型）、装 omp-task 并配好「OMP 跑完自动叫醒 Bot」的 webhook，并跑通一次验收。装好后日常派活看 grokbot-omp-dispatch。
---

# grokbot-omp-setup：让 Grok Bot 能派活给 OMP

目标：Grok Bot 额度贵，只用来「拆任务 + 验收」；真正干活交给 Bot 电脑上的 **OMP**（[omp.sh](https://omp.sh)，终端优先 coding agent），OMP 用什么模型都行（官方 API、OAuth、中转站、自建网关或 OMP 默认额度），花的是你自己的额度。

做完应该满足三条：
1. Bot 的 Shell 里 `omp -p 'reply ok' --no-session`（或指定 `--model provider/model`）回复 ok。
2. `~/tools/omp-call/omp-task` 能跑，有一个 webhook 例行任务能把 Bot 单独叫醒。
3. 两个密钥 `<BOT>_OMP_NOTIFY_URL`、`<BOT>_OMP_NOTIFY_KEY` 已存好，Bot 不在聊天里打印它们。

按下面顺序做，每步验收过再往下走。删除、付款、登录、push 这类动作先问用户。

## 1. 装 OMP

- 官方安装（macOS / Linux）：
  ```bash
  curl -fsSL https://omp.sh/install | sh
  omp --version
  ```
- 本项目包装脚本需要 **Node.js >= 22**：`node -v`。
- 先跑通最小探活：
  ```bash
  omp -p 'reply ok' --no-session
  ```
  回复 ok 说明 OMP 本身与模型通路可用。

## 2. 给 OMP 接一个模型（来源随意）

挑你手上有的额度（详情参见 `docs/quota.md`）：
- **官方 / OAuth**：在终端运行 `omp`，输入 `/login`，按提示完成浏览器授权。凭据由 OMP 自己管理，**不要**让 Bot 读取或打印 `~/.omp/agent/` 下的凭据库。
- **官方 API Key / OpenAI 兼容中转站**：在 `~/.omp/agent/models.yml` 声明 provider，`apiKey` 写环境变量名（不要把真实 key 写进仓库或聊天）：
  ```yaml
  providers:
    my-relay:
      baseUrl: https://api.relay-example.com/v1
      api: openai-completions
      apiKey: MY_RELAY_API_KEY
      models:
        - id: claude-3-5-sonnet-20241022
          name: Claude 3.5 Sonnet
          contextWindow: 200000
  ```
  然后 `export MY_RELAY_API_KEY=...` 并验证：
  ```bash
  omp -p 'reply ok' --no-session --model my-relay/claude-3-5-sonnet-20241022
  ```
- **自建网关（可选）**：如 Magpie。把订阅或各家 key 统一接进去。若部署在 VPS 上，**务必只监听 Tailscale 内网地址，严禁开放公网端口**，并开启 token 认证。OMP 侧在 `models.yml` 里把 `baseUrl` 指向内网网关。
  - 走网关时强烈建议配通路预检：
    ```bash
    cp ~/tools/omp-call/omp-preflight.example ~/tools/omp-call/omp-preflight
    chmod +x ~/tools/omp-call/omp-preflight
    ```
    按文件内注释改好健康接口和 Tailscale/转发脚本路径。Bot 电脑经常睡眠，醒来后链路可能端口通但请求挂住；`omp-task` 会在派活前用它检查、必要时重连。
- **OMP 默认配置**：如果 `omp -p ...` 已经能通，后续派活甚至不需要指定 `--model`。

## 3. 装 omp-task 并配「跑完自动叫醒」

克隆本仓库并运行安装脚本（会检查 Node >= 22 与 omp，复制到 `~/tools/omp-call`）：

```bash
git clone https://github.com/Chasen-Liao/grokbot-and-omp /tmp/grokbot-and-omp
cd /tmp/grokbot-and-omp && ./install.sh
```

冒烟测试（关闭通知）：
```bash
OMP_NOTIFY_OFF=1 ~/tools/omp-call/omp-task run /tmp 'Reply with only OK' --session smoke --owner <ID>
```
看到 `STATE done` 后确认该任务：
```bash
~/tools/omp-call/omp-task ack <TASK_ID> --owner <ID>
```

然后配唤醒：
1. Bot 自己建一个 webhook 触发的例行任务，例如「OMP 完成唤醒」。内容参见仓库里的 `routines/omp-task-notify.md`：醒来先跑 `omp-task pending --owner <ID>`，按 grokbot-omp-dispatch 第 4 步核验、回报、ack；别的 Bot 的任务不碰。
2. 让用户用密钥输入卡，把 webhook 地址和 key 存成环境变量 `<BOT>_OMP_NOTIFY_URL`、`<BOT>_OMP_NOTIFY_KEY`（不要贴进聊天或文件）。多个 Bot 各用各的变量名前缀。派活时只需加 `--notify-prefix <BOT>`，`omp-task` 会自动读取对应通知配置并完成回调，无需手动映射环境变量。

## 4. 端到端验收

派一个最小任务（比如「在 /tmp/gao-test.txt 写一行 hello」），按 grokbot-omp-dispatch 的命令后台跑，不要结束当前轮，用长时间阻塞等待跑完立刻验收（Webhook 唤醒作为兜底）。确认：`omp-task pending` 里有它、文件内容正确，ack 后 pending 变空。

## 风险，要跟用户说清楚

- OMP 默认没有强沙箱，能改电脑上的任何文件。任务里必须限定目录、禁止删除。
- `omp-guard` 只拦灾难性递归删除/抹盘（`rm -rf /`、`/workspace`、`*`、`~`、`find / -delete`、`mkfs`、`dd of=/dev/`），防君子不防小人；强隔离需要 OMP 官方 sandbox 扩展。
- 若将个人订阅通过网关转成 API 使用，可能违反服务条款，有封号风险，建议用小号。
- 密钥只保存在环境变量中，不写进文件、不打印到聊天界面；OMP 自己的凭据库也不要让 Bot 读取。
