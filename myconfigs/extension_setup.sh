#!/usr/bin/env bash
set -euo pipefail

# 自动生成：pi list；mono 本地包按 package.json 的 name 转为 npm 包。
# 执行本文件前，请先安装 pi 并配置 npm 访问。
pi install npm:@ff-labs/pi-fff
pi install npm:@tmustier/pi-usage-extension
pi install npm:@upstash/context7-pi
pi install npm:@yceachan/pi-better-btw
pi install npm:@yceachan/pi-codex-imagegen
pi install npm:@yceachan/pi-gadget
pi install npm:@yceachan/pi-quiet
pi install npm:@yceachan/pi-shelld
pi install npm:@yceachan/pi-switch-cwd
pi install npm:pi-ask-user
pi install npm:pi-commandcode-provider
pi install npm:pi-context-view
pi install npm:pi-lens
pi install npm:pi-token-speed
pi install npm:pi-web-access
