# pi-vision-helper v0.1.0

## feat

- 新包 `@yceachan/pi-vision-helper`：主模型无视觉能力时的视觉理解委托
  （pi 工具 `pi-vision-helper` + skill + bun CLI，核心为纯 TypeScript 的
  `lib/`，单一 runtime、无 python 依赖）
- 模型/API 配置驱动：`vision.models[]` 支持 `pi-registry` 条目（模糊匹配
  Provider/Model，复用 pi 模型目录与鉴权）与 `responses` 条目（自定义
  baseUrl + `$ENV_VAR`/字面量 apiKey），`vision.active` 选择激活模型；
  `enabled` / `forceVisionBridge` / `maxTokens` / `timeoutMs` / `systemPrompt`
  全局开关与默认值
- 配置优先级：`--config` > `$PI_VISION_HELPER_CONFIG` > `$CWD/.pi/vision-helper.json`
  > `~/.pi/agent/pi-vision-helper.json`；无配置时默认搜索 pi-registry 中首个
  vision-capable luna 模型（当前 gpt-5.6-luna）
- 旧版扁平字段（provider/model/modelMatch/baseUrl/apiKey/apiKeyEnv/cost/
  headers/defaults）兼容读取
- 用量/成本透传：工具层经 usage 上报视觉调用的 token 与成本（registry cost
  或条目自定义 cost）
- Windows（`C:\...`）与 WSL（`/mnt/...`）图片路径、多图一次分析

## fix

- `fuzzyPick` 无匹配不再静默回退首个候选（未知 provider 此前会被静默路由
  到错误后端并扣费）——改为报错并列出可用 providers/models
- `effort=off/minimal` 省略 reasoning 字段（zen 网关映射为 null，直传会
  HTTP 400 invalid_prompt）
- 模型条目 `api` 字段仅作参考（zen 网关对声明为 openai-completions 的模型
  同样服务 `/responses`，kimi-k2.7-code 实测可用）
