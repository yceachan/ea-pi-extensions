# AGENTS.md

## 测试注册纪律

测试编排机制与注册示例见[docs/test-CI-Guide.md](docs/test-CI-Guide.md)，本文列出红线。

- 新增或迁移默认自动化测试时，同一改动必须在所属 package manifest 新增或更新 `scripts.test`。
- 依赖真实 Pi、tmux、模型、凭据、GUI 或外部服务的测试只能注册为 `scripts.test:e2e`，不得并入 `scripts.test`。
- package 没有默认测试时可以省略 `scripts.test`，不得添加无意义的占位脚本。
- 根 manifest 和 CI workflow 不得为单个 package 添加测试路径或专属命令。
- 本地和 CI 的默认全量测试入口统一为 `bun run test`。

## meta docs

```
//$PWD = .agents/issues/
|-open/
| |- <xx-type-issue.md>  # original bug-report | feat-request
| |- <xx-issue>/    # discussion workspace about raw issue
|              |- Research.md
|              |- ADR.md
|              |- route.md            
|-closed/xx
        |- xx-issue : mv original issue to here.
        |- close.md : writes how cover this issue,relates to commit/PR.


```

## 主线提交纪律

提交规范见[docs/git提交规范.md](docs/git提交规范.md)，本文补充agent红线。

### 提交红线

- 只提交**本次会话你自己改动**的文件：`git add $WORK/*` ，与Session goal 的无关改动不提交。
- 规范使用 `./gcm --help ` 完成提交。
- 核对并报告提交范围「提交 hash + 文件清单」。
- 在开发者首肯前，禁止`git commit --no-verify`、`git reset --hard`、`git checkout .`、
  `git clean -fd`、`git stash`，仓库历史修剪必须先报告开发者拟定方案。

### 推送红线

- 开发者审阅前，禁止自主推送。
- release 走 `./gbump --help`，由 tag 驱动 CI 发版，打 tag 一律经由 `./gbump`。

### 发布边界

- 通过`./gbump`CI发版
- clean workspace is a must .对**未提交，未追踪改动**不覆盖，不提交、不丢弃，报告开发者后等待指示。
