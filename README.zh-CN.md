# ea-pi-extensions

**[English](README.md) | 简体中文**

[yceachan](https://github.com/yceachan) 的 pi 扩展 [bun](https://bun.sh) workspace monorepo。
各包**持有独立的 semver 版本**：一次发布只推进它点名的包，每个逐包 tag（`<pkg>@<ver>`）
自身就是一条发布指令。

## 包清单

| 包 | 说明 | Gallery |
| --- | --- | --- |
| [`@yceachan/pi-shelld`](packages/pi-shelld) | `shell_daemon` 工具 + ⭕shell TUI 监视器，管理长驻后台进程 | [pi.dev](https://pi.dev/packages) |
| [`@yceachan/pi-vision-helper`](packages/pi-vision-helper) | 主模型无视觉能力时的配置驱动视觉委托（复用 pi-registry 或自定义 responses API）——纯 TypeScript、单一 runtime | [pi.dev](https://pi.dev/packages) |
| [`@yceachan/pi-gadget`](packages/pi-gadget) | 单文件小工具：`/clear` 会话归档、`/exit`、`pi-cite-wslpath`（WSL 路径 → Windows Terminal 可点超链接，批量 `paths[]`，agent_end 交付泄漏强制检查） | [pi.dev](https://pi.dev/packages) |
| [`@yceachan/pi-switch-cwd`](packages/pi-switch-cwd) | `/cwd`——切换会话工作目录 | [pi.dev](https://pi.dev/packages) |
| [`@yceachan/pi-better-mermaid`](packages/pi-better-mermaid) | `better-mermaid`——把 writing-mermaid 规则打包为 skill，用 mmdc 校验门禁 agent 产出的图，结构化错误循环重试（3 次）· [能力评估](packages/pi-better-mermaid/skills/better-mermaid/evals/README.md) | [pi.dev](https://pi.dev/packages) |

## 仓库结构

```text
.
├── packages/           # workspace 成员（bun workspaces）
│   ├── pi-gadget/
│   ├── pi-vision-helper/
│   ├── pi-shelld/
│   ├── pi-switch-cwd/
│   └── pi-better-mermaid/
├── gcm                      # bash 入口 → scripts/gcm.mjs（bun run gcm）
├── gbump                    # bash 入口 → scripts/gbump.mjs（手工发版一键入口）
├── scripts/
│   ├── lib.mjs              # 共享：registry 查询、模糊 scope 解析、ask()
│   ├── gcm.mjs              # 手动提交入口（type/scope 校验、模糊 scope 选择）
│   ├── gbump.mjs            # 纯薄壳：参数翻译 → 委托 mono-release
│   ├── mono-release.mjs     # 逐包 bump + release 提交 + 逐包 tag + push
│   ├── mono-tagcheck.mjs    # 逐包版本号检查/对齐/复位（无 git 写操作）
│   └── completions/
│       └── _gbump           # zsh 补全（#compdef gbump gcm）：-p 候选、flags、type 词表
├── docs/                     # 提交/发版规范 + tag 回退与 CI 容灾 runbook
│   ├── git提交规范.md
│   ├── 发行版本控制策略.md
│   └── tag回退与CI容灾.md
├── changelog/
│   └── <pkg>/vX.Y.Z/log.md  # 逐包发布说明（手工，docs(changelog):）
└── .github/workflows/
    └── publish.yml     # tag 触发的 CI 发布（npm OIDC、provenance）
```

## 脚本能力（模糊匹配 + zsh 补全）

根仓 `scripts/` 工具链提供两项开发能力：

- **`-p` 模糊匹配**（gcm / gbump 共享 `scripts/lib.mjs` 的 `resolvePackageScope`）：
  输入包名片段即解析出完整包名——匹配面含 packages/* 包名、二级裸根 .ts 小工具
  （`-p cite-wslpath` → `pi-gadget`）与 gcm 的跨切面词表
  （scripts/ci/docs/release/changelog/root）；TTY 下回车确认首选、输入序号或
  完整包名精确指定，非交互需 `-y` 接受唯一候选
- **zsh 命令补全**（`scripts/completions/_gbump`，`#compdef gbump gcm`）：`-p` 包名
  候选动态扫描 packages/*（gcm 另附跨切面词；`-c` 骨架模式除外）；flags 与 type
  词表随脚本 --help 同步；`--set-ver` / `-m` / `-b` 的值位不落文件补全。安装：
  把 `scripts/completions` 加入 fpath（须在 compinit 之前）

完整规范见 [docs/发行版本控制策略.md](docs/发行版本控制策略.md)（模糊规则、补全安装、
发版仪式）与 [docs/git提交规范.md](docs/git提交规范.md)（提交纪律）。

## 安装

```bash
pi install npm:@yceachan/pi-shelld
pi install npm:@yceachan/pi-vision-helper
pi install npm:@yceachan/pi-gadget
pi install npm:@yceachan/pi-switch-cwd
pi install npm:@yceachan/pi-better-mermaid
```

## 开发

```bash
bun install             # 安装 workspace（单一根 bun.lock）
bun run typecheck       # typecheck 全部包
bun run gcm             # 手动提交助手（见 docs/git提交规范.md）
```

手动提交遵循 [`docs/git提交规范.md`](docs/git提交规范.md) 的约定；`gcm` 入口负责拼装并校验
`type(scope): subject`，只提交你显式暂存的内容：

```bash
git add packages/pi-shelld/src/…
bun run gcm -- -t fix -p shelld -m "drain zombie shells on session end"
```

无构建步骤——pi 经 jiti 直接加载 TypeScript。改完源码在 pi 里 `/reload` 即可。

## 发布

逐包版本、tag 即发布指令：

```bash
./gbump -p pi-gadget --minor                   # 一键发版：守卫后直接执行
./gbump -p pi-gadget --set-ver 0.5.0           # 显式目标版本
./gcm -c -p pi-gadget --minor                  # 创建 changelog 骨架，打印路径与提交提示
bun run mono-release -- pi-gadget minor pi-shelld patch  # 直接走仪式（守卫与 gbump 相同）
```

`./gbump` 是手工发版一键入口：纯薄壳，委托 `scripts/mono-release.mjs` 执行，后者强制
干净工作区、包本地版本 == registry 基线、`changelog/<pkg>/vX.Y.Z/log.md` 存在且含实质
条目、包自上个逐包 tag 以来有实质变更——然后只 bump 点名的包、同步 `bun.lock` 的
workspace 版本字段、提交 `release: pi-gadget@0.3.0`、逐包打 tag `pi-gadget@0.3.0` 并推送。
发布说明先行：`./gcm -c -p <pkg> --minor` 创建 `changelog/<pkg>/vX.Y.Z/log.md` 骨架，
填写后以 `docs(changelog): <pkg> vX.Y.Z` 提交。
`publish.yml`（触发：匹配 `*@*` 的 tag）解析 tag、校验 `packages/<pkg>/package.json` 版本
与 tag 一致，用 `npm publish --provenance`（OIDC 信任发布）精确发布该包。`workflow_dispatch`
干跑入口走同样的校验但不发布——改管线前用它验证。

`bun run mono-tagcheck` 显示各包本地版本 vs registry 基线；`--sync` 把落后包对齐到基线
并自动 `bun install` 刷新 workspace（`bun.lock` 跟随），报告文件变动与脏树状态——它只调整
manifest 里的版本号，绝不 commit/tag/push。零发布失败后 `--reset` 把领先包复位回已发布
基线；完整恢复流程见 runbook（`docs/tag回退与CI容灾.md`）。

前置条件（一次性）：为每个包配置 npm [Trusted Publishers](https://docs.npmjs.com/trusted-publishers/)
——仓库 `yceachan/ea-pi-extensions`、workflow `publish.yml`。

## License

MIT
