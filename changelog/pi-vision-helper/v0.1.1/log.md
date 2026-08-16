# pi-vision-helper v0.1.1

## feat

- 主模型 VLM 门控：工具检查当前主模型的 `input` 能力（`ctx.model.input`），
  主模型本身可看图（含 `"image"`）且未配置 `forceVisionBridge: true` 时拒绝
  委托并给出指引；`input` 缺失时不判。CLI 无主模型概念，始终可委托
- 取消透传：工具取消信号（Esc）接入请求——`AbortSignal.any([signal, timeout])`，
  在途视觉请求可被取消，不再跑满默认 300s；超时与取消报错分离
- `defaultEffort` 顶层配置：默认思考深度可配（工具/CLI 的 `effort` 参数覆写）；
  旧版 `defaults.effort` 同步生效（此前被解析但从不应用）
- `effort` 值域补 `minimal`（与 `off` 同语义：省略 reasoning 字段，不再被
  工具 schema / 配置校验拒绝）

## fix

- pi-registry 条目 `cost` / `headers` 配置此前被静默忽略——现在生效：`cost`
  覆盖 models-store 条目价（影响 usage 成本上报），`headers` 合并进请求
- `vision.active` 未知名不再静默回退首个条目——改为报错并列可用名
  （与 CLI `--model` 行为一致，避免拼错路由到错误后端并扣费）
- 未知图片扩展名不再默认标为 `image/jpeg`——改为报错；支持列表补
  `.jfif` / `.heic` / `.avif`
- `maxTokens` / `defaults.maxTokens` / `--max-tokens` 增加 256–32768 边界
  校验，配置非法值在加载时即报错
- legacy 模式鉴权来源报错信息插值 provider 名（原为字面量 `auth.json[provider]`）

## chore

- package.json 补 `typecheck` 脚本（CI 的 `bun run --filter '*' typecheck`
  不再跳过本包）、`files` 补 `README.zh.md`（tarball 不再缺中文文档）、
  补 `"type": "module"` 与 typescript devDep
- 工具 schema `images` 加 `minItems: 1`（空数组不再可过 schema 发纯文本请求）
- 删除 config.ts 死代码 `expandApiKey`（vision.ts 内另有实现）

## test

- 新增 `lib/vision-helper.test.ts`：65 项单测（fuzzyPick 四档优先级、Windows
  路径转换、cost 公式、config 解析与校验、active 解析），`node` 直跑；
  lib 内部 import 改用 `.ts` 扩展名（node 类型剥离可直接运行）

## docs

- README.md / README.zh.md / SKILL.md 同步：门控与 forceVisionBridge、defaultEffort、
  active 未知名报错、minimal 值域、MIME 支持列表、超时/取消与新增报错的排查表
