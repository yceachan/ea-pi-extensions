# v0.1.1

首次正式发布（registry 种子 0.1.0 之后的第一个 tag 版本，四包同发）。

## feat

- pi-shelld：`shell_daemon` 工具 + ⭕shell TUI 监视器，管理长驻后台进程
- pi-oc-go-luna-vision：主模型无视觉能力时经 gpt-5.6-luna 提供图片理解（skill + 工具）
- pi-gadget：`/clear` 会话归档、`/exit` 退出等单文件小工具
- pi-switch-cwd：`/cwd` 会话工作目录切换

## ci

- publish.yml 修正变更包判定：diff 排除 release 提交本身（`prev..HEAD^`），按需发布/版本空洞真正生效；GITHUB_OUTPUT 多行值修复；action 固定到 commit SHA

## fix

- mono-release.mjs 新增三个守卫：干净工作区、非空发布、目标版本已发布检查；提交改为 `release: vX.Y.Z`
- mono-sync.mjs：`--set` 缺版本参数时报错（此前静默空转）

## docs

- 新增 Git 提交规范（type/scope 词表、提交卫生、changelog 纪律）
- 版本控制策略、README 对齐新的发版仪式与 changelog 结构
