---
title: ea-pi-extensions Git 提交规范
tags: [git, commit, conventional-commits, monorepo, release, changelog]
desc: 提交信息格式（type/scope 词表）、提交卫生、release 提交与 changelog 纪律、分支与 PR 约定
update: 2026-08-16
---

# ea-pi-extensions Git 提交规范

> [!note]
> **Ref:** `../../source/AGENTS.md`（上游惯例来源，pi 仓库）| [AGENTS.md](../AGENTS.md)（agent 执行层纪律）| [docs/发行版本控制策略.md](发行版本控制策略.md)（版本与发布语义）| [scripts/gcm.mjs](../scripts/gcm.mjs)（手动提交入口）| [scripts/mono-release.mjs](../scripts/mono-release.mjs) | [scripts/mono-tagcheck.mjs](../scripts/mono-tagcheck.mjs)


本规范与上游 pi 仓库同源：`type(scope): subject` 的格式与措辞惯例取自 pi 的 AGENTS.md 与提交历。

## 提交信息格式

```
type(scope): subject
```

### type 词表（八型）

| type | 含义 | 示例 |
| --- | --- | --- |
| `feat` | 新功能、新包、新扩展 | `feat(pi-shelld): add TUI monitor for background shells` |
| `fix` | 缺陷修复 | `fix(pi-gadget): archive session on /clear` |
| `docs` | 文档与 changelog | `docs(changelog): pi-gadget v0.3.0` |
| `chore` | 杂务：依赖、元数据、基线对齐 | `chore: bump devDependencies` |
| `refactor` | 行为不变的重构 | `refactor(pi-shelld): extract poll loop` |
| `test` | 测试新增/修改 | `test(pi-switch-cwd): cover path edge cases` |
| `ci` | CI 流水线与发布管线 | `ci: publish the package named by the tag` |
| `release` | 发版提交——**仅由 mono-release.mjs 生成，禁止手写** | `release: pi-gadget@0.3.0` |

不预占 `perf` / `build` / `style` / `revert`：本仓库无对应场景，出现时归入最接近的既有类型并在 subject 说明。

### scope 词表

- **包名（单一包变更必填）**：see `packages/*`
- **跨切面**：`scripts`（工具脚本）、`ci`（workflow）、`docs`（文档）、`release`（发版流程）、`changelog`（发布说明）、`root`（根 manifest / workspace 配置）

### subject 规则
- 说清**改了什么**，不说"改代码"：`fix(pi-shelld): drain zombie shells on session end` ✓，`fix stuff` ✗
- 涉及 issue/PR 时以 `(#NNNN)` 结尾（外部 PR 场景）

### body 规则

非显然的变更写 body：**问题 → 具体示例或简短追踪 → 方案**，并说明为什么这个方案是必要的。跨包改动、事故修复、设计决策必须写。

## 提交入口（gcm）

see `./gcm --help`


## Changelog


```text
changelog/
├── pi-gadget/
│   └── v0.3.0/
│       └── log.md      # 该包该版本的发布说明
└── ...
```

- **手工撰写、随代码一并提交**（Q：为何不是脚本生成？——发布说明需要人判断，脚本只负责版本仪式）
- 推荐工作流（一次提交）: feat 开发完成后先 `./gcm -c -p <pkg> --[minor | patch | major]` 创建骨架 → 填写
  条目 → 代码与 `changelog/<pkg>/vX.Y.Z/log.md` 一并 `git add` →
  `./gcm -t <type> -p <pkg> -m "..."` 一次提交
- `mono-release.mjs` 硬性要求 `changelog/<pkg>/v<ver>/log.md` 已存在且含实质 `-` 条目

```text
# <@pkg/Ver>

## feat
- ...

## fix
- ...
```

