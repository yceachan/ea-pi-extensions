---
title: ea-pi-extensions 测试与 CI 指南
tags: [test, ci, bun, monorepo, github-actions]
desc: 默认测试入口 bun run test 的编排机制、package 测试注册纪律（scripts.test / scripts.test:e2e）与 CI 结构

update: 2026-08-30
---

# ea-pi-extensions 测试与 CI 指南

> [!note]
> **Ref:** [AGENTS.md](../AGENTS.md)（纪律源头）| [package.json](../package.json)（编排入口）| [.github/workflows/ci.yml](../.github/workflows/ci.yml) | [docs/git提交规范.md](git提交规范.md)

## 一句话纪律

新增或迁移测试时，同一改动在所属 package 的 `package.json` 注册 `scripts.test`（默认测试）或 `scripts.test:e2e`（环境依赖测试）；本地与 CI 的全量测试入口统一为 `bun run test`。

## 入口编排

根 manifest 定义三段式入口：

```json
"test": "bun run test:repo && bun run test:packages",
"test:repo": "bun test scripts/tests/",
"test:packages": "bun run --workspaces --sequential --no-exit-on-error --if-present test",
"test:e2e": "bun run --workspaces --sequential --no-exit-on-error --if-present test:e2e"
```

`bun run test` 的执行流：

```text
bun run test
├─ bun test scripts/tests/                # repo 级脚本测试（test:repo）
└─ bun run --workspaces … --if-present test   # 逐包执行 scripts.test（test:packages）
   ├─ @yceachan/pi-better-btw       bun test test/
   ├─ @yceachan/pi-codex-imagegen   bun test test/
   ├─ @yceachan/pi-gadget           bun test test/
   ├─ @yceachan/pi-shelld            bun test test/
   ├─ @yceachan/pi-switch-cwd       bun ./cwd-utils.test.ts
   ├─ @yceachan/pi-vision-helper    bun ./lib/vision-helper.test.ts
   └─ @yceachan/pi-wsl-browser      bun test test/ && cd runtime/browser-harness && uv run --frozen --extra test pytest -q
```

workspace 编排 flag 语义：

| flag | 语义 |
| --- | --- |
| `--workspaces` | 遍历全部 workspace，逐包查找同名脚本 |
| `--sequential` | 串行执行；TUI / 终端类测试互不抢屏，输出可判读 |
| `--if-present` | 未注册 `scripts.test` 的包直接跳过，不报错 |
| `--no-exit-on-error` | 单包失败后继续跑完剩余包；聚合退出码保持非零，CI 仍红 |

bun 以**该 package 目录**为 cwd 执行其 workspace 脚本，包内脚本可放心使用相对路径（如 `bun ./cwd-utils.test.ts`）。

## 注册纪律

| 规则 | 原因 |
| --- | --- |
| 新增或迁移默认自动化测试时，同一改动必须在该 package manifest 新增或更新 `scripts.test` | 只落测试文件不注册，`bun run test` 会静默跳过，形同没写 |
| 依赖真实 Pi、tmux、模型、凭据、GUI 或外部服务的测试只能注册为 `scripts.test:e2e` | 这类环境 CI 与他人机器不可复现，混入默认入口会让 `bun run test` 不可信 |
| package 没有默认测试时省略 `scripts.test`，不添加占位脚本 | `"test": "echo ok"` 之类的占位掩盖"此处无测试"的事实 |
| 根 manifest 与 CI workflow 不得为单个 package 添加测试路径或专属命令 | 专属命令绕过包自治，测试会随包迁移而失联 |
| 本地和 CI 的默认全量测试入口统一为 `bun run test` | 一个入口，本地红了 CI 必红，无第二真相 |

测试归属判定：

| 测试依赖 | 归属 | 现有示例 |
| --- | --- | --- |
| 纯函数、临时目录、内存 mock | `scripts.test` | `cwd-utils.test.ts`、`vision-helper.test.ts` |
| 真实 Pi、tmux、模型调用、凭据、GUI、外部服务 | `scripts.test:e2e` | `e2e-test.sh`（tmux + 真实 pi + 默认模型） |
| 尚无测试 | 省略字段 | `pi-better-mermaid` |

## 注册示例

默认测试（`pi-vision-helper`）：

```json
"scripts": {
  "typecheck": "tsc --noEmit -p tsconfig.json",
  "test": "bun ./lib/vision-helper.test.ts"
}
```

默认 + e2e 并存（`pi-switch-cwd`）：

```json
"scripts": {
  "test": "bun ./cwd-utils.test.ts",
  "test:e2e": "bash ./e2e-test.sh"
}
```

## CI 结构

[ci.yml](../.github/workflows/ci.yml) 双 job，均为 `persist-credentials: false` + SHA 锁定的 setup-bun（1.3.14）；`test` job 另以 SHA 锁定的 setup-uv（uv 0.12.3）提供运行时测试依赖：

| job | 步骤 |
| --- | --- |
| `typecheck` | `bun install --frozen-lockfile` → `bun run typecheck` |
| `test` | setup-uv（SHA）→ `bun install --frozen-lockfile` → `bun run test` |

`scripts.test:e2e` 不进 CI，手动执行：`bun run test:e2e`（需 tmux 与 `~/.pi/agent/settings.json` 中的默认模型）。

## 反模式

- ✗ 根 manifest 写 `bun test packages/foo/test/` —— 单包专属命令
- ✗ ci.yml 为单包加 step —— 同上，且与本地入口分叉
- ✗ 依赖真实环境的测试塞进 `scripts.test` —— 默认入口失去可复现性
- ✗ 无测试却写占位脚本 —— 掩盖事实
- ✗ 测试文件已落地、manifest 未注册 —— `bun run test` 静默跳过
