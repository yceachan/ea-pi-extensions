# ea-pi-extensions

**[English](README.md) | 简体中文**

[yceachan](https://github.com/yceachan) 的 pi 扩展 [bun](https://bun.sh) workspace monorepo。
逐包 tag（`<pkg>@<ver>`）发布。

## Packages

| 包 | 说明 | Gallery |
| --- | --- | --- |
| [`@yceachan/pi-better-btw`](packages/pi-better-btw) | `/btw`，fork 自 [nicobailon/pi-side-chat](https://github.com/nicobailon/pi-side-chat)，用 overlay 窗口进行主线旁路问答；共享主线提示词前缀，并用旁路约束防止 Agent 干扰主线工作 | [pi.dev](https://pi.dev/packages/@yceachan/pi-better-btw) |
| [`@yceachan/pi-better-mermaid`](packages/pi-better-mermaid) | `better-mermaid`——把 Mermaid 规范整理为 skill，针对 Typora 的渲染边界用 `mmdc` 校验，并处理语法错误重试 | [pi.dev](https://pi.dev/packages/@yceachan/pi-better-mermaid) |
| [`@yceachan/pi-codex-imagegen`](packages/pi-codex-imagegen) | 复用本地 Codex 登录态调用 `imagegen` 生成图像；由独立加载的 `pi-shelld` 展示实时日志、状态与耗时 | [pi.dev](https://pi.dev/packages/@yceachan/pi-codex-imagegen) |
| [`@yceachan/pi-gadget`](packages/pi-gadget) | 单文件小工具：`/clear` 归档会话、`/exit` 退出 pi、`pi-cite-wslpath` 把 WSL 路径转换为 Windows Terminal 可点的超链接 | [pi.dev](https://pi.dev/packages/@yceachan/pi-gadget) |
| [`@yceachan/pi-shelld`](packages/pi-shelld) | `shell_daemon` 工具 + ⭕shell TUI 监视器，管理会话级后台 shell（服务器、监听器）；其他扩展可通过 `pi.events` 发现并复用其服务 | [pi.dev](https://pi.dev/packages/@yceachan/pi-shelld) |
| [`@yceachan/pi-switch-cwd`](packages/pi-switch-cwd) | `/cwd`——切换会话工作目录 | [pi.dev](https://pi.dev/packages/@yceachan/pi-switch-cwd) |
| [`@yceachan/pi-vision-helper`](packages/pi-vision-helper) | 主模型无视觉能力时的视觉理解工具；可复用 pi-registry 或自定义 Responses API | [pi.dev](https://pi.dev/packages/@yceachan/pi-vision-helper) |

## Install

```bash
pi install npm:@yceachan/pi-better-btw
pi install npm:@yceachan/pi-better-mermaid
pi install npm:@yceachan/pi-codex-imagegen
pi install npm:@yceachan/pi-gadget
pi install npm:@yceachan/pi-shelld
pi install npm:@yceachan/pi-switch-cwd
pi install npm:@yceachan/pi-vision-helper
```
## Layout

```text
.
├── packages/           # workspace 成员（bun workspaces）
│   ├── pi-better-btw/
│   ├── pi-better-mermaid/
│   ├── pi-codex-imagegen/
│   ├── pi-gadget/
│   ├── pi-shelld/
│   ├── pi-switch-cwd/
│   └── pi-vision-helper/
├── gcm                      # bash 入口 → scripts/gcm.mjs（bun run gcm）
├── gbump                    # bash 入口 → scripts/gbump.mjs（手工发版一键入口）
├── sync-readme              # bash 入口 → scripts/sync-readme.mjs（README 包清单表+安装块重建）
├── scripts/
│   ├── lib.mjs              # 共享：registry 查询、模糊 scope 解析、ask()
│   ├── gcm.mjs              # 手动提交入口（type/scope 校验、模糊 scope 选择）
│   ├── gbump.mjs            # 纯薄壳：参数翻译 → 委托 mono-release
│   ├── sync-readme.mjs      # 重建 README 包清单表 + 安装块（gallery → 逐包 pi.dev 页面）
│   ├── mono-release.mjs     # 逐包 bump + release 提交 + 逐包 tag + push
│   ├── mono-tagcheck.mjs    # 逐包版本号检查/对齐/复位（无 git 写操作）
│   └── completions/
│       └── _gbump           # zsh 补全（#compdef gbump gcm）：-p 候选、flags、type 词表
├── docs/                     # 提交/发版规范 + tag 回退与 CI 容灾 runbook
│   ├── git提交规范.md
│   ├── 发行版本控制策略.md
├── changelog/
│   └── <pkg>/vX.Y.Z/log.md  # 逐包发布说明（手工，docs(changelog):）
└── .github/workflows/
    └── publish.yml     # tag 触发的 CI 发布（npm OIDC、provenance）
```

## 开发

```bash
bun install             # 安装 workspace
bun run typecheck       # 检查全部包的类型
./gcm --help            # 查看提交助手用法
ls docs/*               # 查看仓库文档
```

## License

MIT copyright @2026 yceachan
