# AGENTS.md


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
- relase走`./gbump --help`, 由tag => CI 发ban，打tag一律经由`./gbump`。

### 发布边界

- 通过`./gbump`CI发版
- clean workspace is a must .对**未提交，未追踪改动**不覆盖，不提交、不丢弃，报告开发者后等待指示。
