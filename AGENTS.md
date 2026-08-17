# AGENTS.md

本文件是 AI agent 在本仓库（ea-pi-extensions）工作的执行层纪律。人类提交规范见
[docs/git提交规范.md](docs/git提交规范.md)，本文件不重复其词表，只补 agent 特有的红线。

## 提交纪律

### 提交（本地 commit）可以先行，作为审阅单元

- 只提交**本次会话你自己改动**的文件：显式 `git add <path1> <path2>`；
  禁止 `git add -A` / `git add .`（避免夹带其他会话或无关改动）。
- 提交信息必须走 `./gcm`（type/scope 词表校验、subject ≤100 字符、小写开头、
  无 emoji）；`release:` 提交禁止手写，只由 mono-release 生成。
- 提交前 `git status` 核对暂存范围；提交后报告「提交 hash + 文件清单」。
- 禁止：`git commit --no-verify`、`git reset --hard`、`git checkout .`、
  `git clean -fd`、`git stash`、`git add -A`、`git add .`。

### 推送红线（核心规则）

- **开发者审阅前，禁止自主推送。** `git push`、`git push --tags`、推送/删除
  远端 tag、`gh release create` 等一切远端写操作，必须先经开发者审阅本地
  改动并**明确批准**后执行。审阅未批准 = 不推。
- 本地提交可以先行；会话收尾时必须报告「本地未推送提交清单（hash + 主题）」
  并等待开发者指示，而不是顺手推上去。
- 发版仪式（mono-release：bump → 提交 → tag → push）本身包含 push——执行
  发版命令同样需要开发者的明确指示，不得因"仪式脚本自带 push"而视为已授权。
- **永远禁止 force push**；已推送的历史不 amend、不改写（正常发布后的 tag
  永不改写，例外仅限 docs/tag回退与CI容灾.md 场景 B 的零发布 tag 重写，
  且须开发者逐条确认）。

### 发布边界

- 本地**永不执行** `npm publish`——发布凭据只存在于 GitHub↔npm 的 OIDC 信任链
  （docs/发行版本控制策略.md）。
- `mono-tagcheck` 只调整各包 manifest 的 version 号，不 commit / 不 tag /
  不 push；版本控制动作（commit/tag/push）属于 mono-release，见上一条。
- 发现工作区存在**他人的未提交改动**（并行编辑）时：不覆盖、重读和编辑自己的板块，不提交、不丢弃，
  报告开发者后等待指示。
