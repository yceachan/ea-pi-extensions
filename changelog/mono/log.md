# mono（根仓脚本与工具链）

根仓级（非包）变更记录。mono 不发布（根 manifest `private: true`、无版本号），
故不设 vX.Y.Z 目录，按日期时间线维护；包级发布说明见
`changelog/<pkg>/vX.Y.Z/log.md`。

## 2026-08-16

### feat

- gbump/gcm `-p` 模糊匹配统一为 scripts/lib.mjs 的 `resolvePackageScope` 一份实现：
  9dec42b 的模糊解析原只接入 gcm，gbump/mono-release 仍走精确路径查找；现 gbump
  委托 mono-release 前先解析出完整包名（mono-release 保持精确——批式位置参数
  CLI 模糊化会歧义）
  - 匹配面：packages/* 包名 + 二级裸根 .ts 小工具映射到母包（`cite-wslpath` →
    pi-gadget）；gcm 另含跨切面词表 scripts/ci/docs/release/changelog/root
  - 二次确认：TTY 回车确认首选 / 输入序号或完整包名；非 TTY 唯一候选需 `-y`
- zsh 补全 `scripts/completions/_gbump`（`#compdef gbump gcm`）：
  - `-p` 包名候选动态扫描 packages/*，gcm 分支另附跨切面词表（`-c` 骨架模式
    除外——其要求精确包名）；flags / type 词表随 --help 同步；`--set-ver` /
    `-m` / `-b` 值位不落文件补全
  - 仓库根由补全文件在 fpath 的位置推导（多处命中取首个），不依赖调用时 cwd，
    不依赖 functions_source（zsh 5.8 autoload 路径下为空）

### fix

- ask() 对 Ctrl-D EOF（answer === null）不再抛 TypeError——原样上抛，按取消处理
- 补全 root 推导：fpath 多处含 _gbump 时显式取首元素，此前标量拼接产生空格粘连
  的垃圾路径、静默落到 PWD 兜底

### docs

- README 拆分为中英双语：README.md（en）+ README.zh-CN.md（完整中文翻译，含
  脚本能力简介：-p 模糊匹配与命令补全）；结构树对齐现状（lib.mjs / completions）
- docs/发行版本控制策略.md 补 zsh 补全安装说明与 gbump 模糊规则（二级小工具映射）

## 2026-08-15

### feat

- gcm `-p` 模糊匹配（scripts/lib.mjs）：包名 + 二级裸根 .ts 小工具（`cite-wslpath`
  → pi-gadget），TTY 回车确认首选 / 输入完整包名精确指定
- gcm `-c` 提示改为 one-pass 工作流优先：代码与 changelog 一次提交，
  `docs(changelog)` 降为次选；`--list` 列出全部 packages@versions
