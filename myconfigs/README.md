# Agent 配置同步

每天新加坡时间 00:00，用户级 systemd timer 执行 `sync-extensions.py`，将以下本机配置同步到本目录。有变化时通过仓库 `./gcm` 创建 `chore(root): sync agent configs` 提交并推送当前 main 的 upstream。机器关机错过定时任务时，下次用户服务启动补跑一次。

| 来源 | 仓库副本 | 同步方式 |
| --- | --- | --- |
| `pi list` 用户扩展 | `extension_setup.sh` | npm 来源保留版本，mono 本地包使用 `package.json` 的 `name`；安装命令排序去重 |
| `~/.codex/AGENTS.md` | `AGENTS.md` | 全局系统提示词原文；当前 Pi 的全局 `AGENTS.md` 也链接到该来源 |
| `~/.agents/skills/` | `skills/` | 完整复制技能内容，展开符号链接，并同步删除已经移除的技能 |

在已安装 Pi 的机器执行安装清单：

```bash
bash myconfigs/extension_setup.sh
```

恢复全局系统提示词和通用技能时，将 `myconfigs/AGENTS.md` 复制到 `~/.codex/AGENTS.md`，将 `myconfigs/skills/` 中的技能复制到 `~/.agents/skills/`。本任务的同步方向为本机配置到仓库。

服务按本机 mono 路径 `~/work/pi-agent-harness/mono` 配置。安装或更新服务：

```bash
install -Dm644 myconfigs/systemd/pi-extension-sync.service ~/.config/systemd/user/pi-extension-sync.service
install -Dm644 myconfigs/systemd/pi-extension-sync.timer ~/.config/systemd/user/pi-extension-sync.timer
systemctl --user daemon-reload
systemctl --user enable --now pi-extension-sync.timer
```

预览、立即同步与查看日志：

```bash
python3 myconfigs/sync-extensions.py --print
systemctl --user start pi-extension-sync.service
journalctl --user -u pi-extension-sync.service -n 50 --no-pager
systemctl --user list-timers pi-extension-sync.timer
```

同步只暂存上表中的副本，其他未暂存改动保留在工作区。仓库处于 main 且暂存区为空时执行；已有其他待推送提交、远端与本地分叉、合并冲突、包来源无法转换、提示词或技能来源缺失时，服务报错并保留现场，处理后可手动启动服务重试。推送失败会保留自动提交，下一次任务重试推送。
