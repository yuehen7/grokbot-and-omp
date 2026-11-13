# 🔧 grokbot-omp-setup

让 Grok Bot 能把执行活派给电脑上的 **OMP**（[omp.sh](https://omp.sh)）：装 OMP → 给 OMP 接一个模型（**官方 API / OAuth / 中转站 / Magpie 网关 / OMP 默认模型**）→ 克隆仓库并运行 `./install.sh` → 配「OMP 跑完 webhook 叫醒 Bot」→ 端到端验收。

**适合谁**：Grok Bot 额度珍贵，想让 Bot 专注于「思考拆解」与「结果验收」，具体的批量代码和文档编写「干活」交给 OMP 并消耗自身模型额度的人。

**安装**
```bash
npx skills add yuehen7/grokbot-and-omp --skill grokbot-omp-setup --global --yes
```

**触发**：对 Bot 说「帮我配好 OMP 派活」「按 grokbot-omp-setup 装一下」。

装好以后日常怎么用，看 [grokbot-omp-dispatch](../grokbot-omp-dispatch/README.md)。

⚠️ OMP 默认没有强沙箱，任务里要限定目录、禁止删除；`omp-guard` 只兜底灾难性删除。
