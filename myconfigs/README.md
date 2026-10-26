# Pi 扩展清单同步

每天新加坡时间 00:00，用户级 systemd timer 执行 `sync-extensions.py`，扫描 `pi list` 的用户扩展，将 npm 来源与 mono 本地包统一整理为 `extension_setup.sh`。本地包使用 `package.json` 的 `name`，npm 来源保留已配置的版本；命令排序去重，清单有变化时通过仓库 `./gcm` 创建 `chore(root): sync Pi extension setup` 提交并推送当前 main 的 upstream。机器关机错过定时任务时，下次用户服务启动补跑一次。

在已安装 Pi 的机器执行安装清单：

```bash
bash myconfigs/extension_setup.sh
```

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

同步只暂存生成的清单，其他未暂存改动保留在工作区。仓库处于 main 且暂存区为空时执行；已有其他待推送提交、远端与本地分叉、合并冲突、包来源无法转换时，服务报错并保留现场，处理后可手动启动服务重试。推送失败会保留自动提交，下一次任务重试推送。
