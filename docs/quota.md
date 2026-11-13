# OMP Subagent 模型额度配置指南

在 Grok Bot 架构中，Grok Bot 负责高价值的意图理解、任务拆解与最终验收，而具体的繁重执行活（如代码编写、批量文件重构、长文本整理）派发给本机运行的 **OMP** coding agent（[omp.sh](https://omp.sh)）。

由于执行过程会消耗大量 Token，为了避免耗尽 Grok Bot 自身的对话配额，OMP 可以灵活使用你自己的模型额度。本文介绍三种常见接入方案。

---

## 方案 A：直接使用 OMP 原生 Provider（推荐，简单稳定）

这是最直接、也是官方推荐的配置方式。为 OMP 接入官方大模型 API Key、OAuth 登录或 OpenAI 兼容格式的中转服务。

### 1. OAuth / 订阅登录
在终端运行 OMP：

```bash
omp
```

输入 `/login`，选择 OMP 支持的 provider，按提示完成浏览器授权。凭据由 OMP 管理，**不要**让 Bot 或子 agent 读取、打印、复制 `~/.omp/agent/` 下的凭据库。

### 2. 官方 API Key / 环境变量
OMP 会读取各 provider 的常规环境变量（如 `DEEPSEEK_API_KEY`、`OPENROUTER_API_KEY`、`ANTHROPIC_API_KEY` 等）。在 Bot 的 shell 环境或 Secret 卡中注入后探活：

```bash
omp -p 'Reply with only OK' --no-session
omp -p 'Reply with only OK' --no-session --model <provider>/<model>
```

设为任务默认模型（可选）：

```bash
export OMP_TASK_MODEL="<provider>/<model>"
```

### 3. OpenAI 兼容中转站
在 `~/.omp/agent/models.yml` 声明自定义 provider。`apiKey` 写环境变量名，不写真实 key：

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

```bash
export MY_RELAY_API_KEY="sk-relay-..."
omp -p 'Reply with only OK' --no-session --model my-relay/claude-3-5-sonnet-20241022
```

若中转站要求显式 Bearer 头，可加 `authHeader: true`；若服务实现 `/v1/responses`，把 `api` 改为 `openai-responses`。字段细节见 OMP 官方 [Custom Models](https://omp.sh/docs/custom-models)。

派活时显式覆盖：

```bash
~/tools/omp-call/omp-task run /path/to/work "编写单元测试" \
  --session task1 --owner mybot --model my-relay/claude-3-5-sonnet-20241022
```

省略 `--model` 且未设置 `OMP_TASK_MODEL` 时，OMP 采用自身配置的默认模型与额度。

---

## 方案 B：自建 Magpie 网关（可选，订阅转 API）

如果你持有网页端订阅配额，并希望将其转化为标准 API 接口以统一供给 OMP 等 coding agent 调用，可以部署类似 Magpie 的转换网关。

### 1. 架构与网络安全最佳实践

```text
[VPS 网关服务]
  └─ 仅绑定 Tailscale 内网地址 (例如 100.64.0.1:8080)
  └─ 严禁开放公网端口 (防火墙关闭公网该端口)
  └─ 开启 Bearer API Key 认证
         ▲
         │ (Tailscale 虚拟局域网加密传输)
         ▼
[Grok Bot 所在机器]
  └─ 接入同一 Tailscale 网络
  └─ ~/.omp/agent/models.yml 的 baseUrl 指向 http://100.64.0.1:8080/v1
```

- **部署在独立 VPS 上**：将网关服务独立托管，不与 Bot 业务容器混部。
- **仅监听内网 IP**：监听 Tailscale 虚拟网卡 IP（例如 `100.64.0.1`）或 Unix Socket，**切勿监听 `0.0.0.0`**。
- **防火墙零公网暴露**：云安全组与 `iptables` 严禁对公网开放该端口。
- **强制密钥认证**：即使在内网，也必须启用网关的 Bearer Token 验证。

### 2. OMP 侧配置示例

```yaml
providers:
  magpie:
    baseUrl: http://100.64.0.1:8080/v1
    api: openai-completions
    apiKey: MAGPIE_TOKEN
    models:
      - id: provider-slug/model-name
        name: Gateway Model
        contextWindow: 128000
```

```bash
export MAGPIE_TOKEN="your-internal-gateway-token"
omp -p 'Reply with only OK' --no-session --model magpie/provider-slug/model-name
```

### 3. 睡醒后链路假死与 omp-preflight

宿主机睡眠醒来后，Tailscale 可能端口通但 HTTP 请求挂住，约 2 分钟后报 `UND_ERR_SOCKET`。网关场景强烈建议配置预检：

```bash
cp ~/tools/omp-call/omp-preflight.example ~/tools/omp-call/omp-preflight
chmod +x ~/tools/omp-call/omp-preflight
```

按文件注释改好健康接口（默认期望短时返回 401）、`tailscaled` 日志路径、Tailscale/转发脚本路径。`omp-task` 会在 `run`/`reply`/`approve`/`deny` 前自动执行；OMP 自动重试连接错误时也会并行再跑一次。

### 4. 合规与封号风险警示

- **服务条款（TOS）限制**：将网页端个人订阅转化为 API 供 Agent 批量调用可能违反对应平台的使用条款。
- **风险防范**：建议使用非主号或专用账号，并设置合理的调用频率与并发限制。

---

## 方案 C：沿用 OMP 默认额度

如果 OMP 本机已经配置好默认模型（`omp -p 'Reply with only OK'` 可直接成功），派活时无需任何 `--model`：

```bash
~/tools/omp-call/omp-task run /path/to/work "重构模块" --session task2 --owner mybot
```

---

## 总结与建议

| 维度 | 方案 A：直接 Provider | 方案 B：自建网关 | 方案 C：OMP 默认 |
| :--- | :--- | :--- | :--- |
| **部署成本** | 零维护，开箱即用 | 需要独立 VPS 及 Tailscale 组网 | 零配置（前提是已配好） |
| **稳定性** | 高（官方 SLA / 成熟中转） | 取决于网关与上游状态 | 取决于本机配置 |
| **适用场景** | 生产开发、追求可靠性 | 已有闲置订阅、多设备共享额度池 | 个人机器、快速试用 |
| **推荐模型** | DeepSeek、Claude、OpenRouter 等 | 按网关支持的订阅模型选择 | 本机已登录/配置的模型 |

## 三种接入的最小验收命令

| 方案 | 探活命令 | 期望 |
| :--- | :--- | :--- |
| A. OAuth 登录 | `omp -p 'Reply with only OK' --no-session` | 输出 `OK`，退出码 0 |
| A. API Key / 中转站 | `omp -p 'Reply with only OK' --no-session --model my-relay/claude-3-5-sonnet-20241022` | 输出 `OK`，退出码 0 |
| B. 自建网关 | `omp -p 'Reply with only OK' --no-session --model magpie/provider-slug/model-name` | 输出 `OK`，退出码 0；配置 `omp-preflight` 后 `omp-preflight` 退出 0 |
| C. OMP 默认 | `omp -p 'Reply with only OK' --no-session` | 输出 `OK`，退出码 0 |

再用任务层验证一次（会创建真实任务与会话）：

```bash
OMP_NOTIFY_OFF=1 ~/tools/omp-call/omp-task run /tmp \
  'Reply with only TASKOK' --session quota-smoke --owner smoke-test [--model <provider/model>]
# 看到 STATE done 后：
~/tools/omp-call/omp-task ack <TASK_ID> --owner smoke-test
```

无论哪种方案：

- 派活时可用 `--model provider/model` 覆盖；
- 默认模型可写入 `OMP_TASK_MODEL`；
- 不要读取/打印 OMP 凭据库或 `models.yml` 中的真实 key；
- 网关务必只监听 Tailscale 内网并启用认证。
