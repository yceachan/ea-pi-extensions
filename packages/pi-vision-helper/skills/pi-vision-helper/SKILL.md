---
name: pi-vision-helper
description: 'Use when the main model lacks vision capability (its input list in ~/.pi/agent/models-store.json has no "image") but the user asks to describe, analyze, or recognize the content of an image, photo, screenshot, or picture — including Windows paths (C:\...) and WSL paths (/mnt/c/...). Sends the image(s) to a configurable vision model (default: gpt-5.6-luna via pi-registry) and returns a detailed description (Chinese by default).'
---

# pi-vision-helper

> **优先使用 `pi-vision-helper` 工具**（`pi-vision-helper` 包注册，参数 schema 强制 `images` 与 `prompt` 必填，直接传参即可）。本 skill 是工具的文档层与兜底方案：承载触发条件、参数语义与排查知识；工具与 CLI 共用同一份 `lib/` 核心（纯 TypeScript，单一 runtime，无 python 依赖）。

## 何时使用（Trigger）

满足以下条件时激活本 skill：

1. 主模型不支持图片 —— 检查 `~/.pi/agent/models-store.json` 中当前模型的 `input` 列表不含 `"image"`
2. 用户要求识别/描述/分析图片内容，或给出图片路径

常见无视觉主模型：`deepseek-v4-flash`、`deepseek-v4-pro`、`glm-5.1`、`glm-5.2`、`hy3`、`minimax-m2.7`、`qwen3.7-max` 等。

配置 `forceVisionBridge: true` 时此限制解除（主模型即使是 VLM 也可委托）。

## 用法

> ⚠️ **`--prompt` 是必填参数**：主模型必须根据用户的具体意图显式构造提示词，禁止省略。省略时脚本直接报错退出（视为 skill 未正确激活）。

CLI 位于本 skill 目录的 `scripts/vision.ts`（bun 直跑，仅用于手动排查；工具已内联同一份 lib，行为一致）：

```bash
cd <skill目录>/scripts

# 必须显式传入提示词
bun vision.ts "C:\Users\yceachan\Pictures\photo.jpg" --prompt "请详细描述这张图片的内容，包括外貌、表情、服装、背景、光线等细节。用中文回答。"

# 多图 / 覆盖配置 / 选择模型条目（按 vision.models[].name）
bun vision.ts a.png b.jpg --prompt "对比这两张图的异同" --config /path/to/config.json --model luna-customer

# 覆盖参数
bun vision.ts img.png --prompt "图中有什么文字？请逐字转录" --effort high --max-tokens 8000 --timeout 60000

# 输出结构化 JSON（排查用）
bun vision.ts img.png --prompt "描述这张图" --json
```

## 配置

配置文件按优先级取第一个存在的（`--config` 与 `$PI_VISION_HELPER_CONFIG` 显式指定时缺失即报错）：

| 优先级 | 路径 | 说明 |
| --- | --- | --- |
| 1 | `--config <path>` | CLI 显式指定（排查用） |
| 2 | `$PI_VISION_HELPER_CONFIG` | 环境变量显式指定 |
| 3 | `$CWD/.pi/vision-helper.json` | 项目级配置 |
| 4 | `~/.pi/agent/pi-vision-helper.json` | 用户级配置 |

无配置文件 = 默认行为：search pi-registry，取最先找到的 provider 里第一个匹配到的 luna 模型（`input` 含 `image`）。

### 配置文件示例

```jsonc
{
  "enabled": true,                  // 总开关；false = 工具拒绝运行
  "forceVisionBridge": false,       // true = 主模型即使是 VLM 也允许委托
  "defaultEffort": "high",          // 默认思考深度（工具/CLI 的 effort 参数可覆写）
  "maxTokens": 4096,                // 默认最大输出 token，工具/CLI 参数可覆写
  "timeoutMs": 60000,               // 默认单次视觉调用超时（毫秒）
  "systemPrompt": "",               // 自定义系统提示词（空 = 使用内置默认）
  "vision": {
    "active": "luna",               // 激活的模型名；未知名 = 报错并列可用名
    "models": [                     // 多模型列表；空列表 = 回退旧版字段/默认 luna 搜索
      {
        "name": "luna",             // 唯一名称（--model / active 用）
        "type": "pi-registry",      // 复用 pi 模型目录（models-store.json），走 pi 鉴权（auth.json）
        "Provider": "opencode-go",  // 模糊匹配最相似的 provider
        "Model": "gpt-5.6-luna"     // 模糊匹配 model list 里最相似的模型（优先 input 含 image 的）
      },
      {
        "name": "luna-customer",    // 唯一名称
        "type": "responses",        // 自定义 OpenAI Responses API 端点
        "baseUrl": "https://opencode.ai/zen/go/v1",
        "apiKey": "$VISION_API_KEY",// 支持 $ENV_VAR 或字面量
        "model": "gpt-5.6-luna",
        "cost": { "input": 0.1, "output": 0.6 }   // 可选：用量计费（缺省 0）
      }
    ]
  }
}
```

模糊匹配规则（确定性）：精确（忽略大小写）> 候选包含查询串 > 查询串包含候选 > **无匹配 = 报错**（绝不静默选首个候选——那会把未知 provider 路由到错误后端并真实扣费）。

### 旧版单模型字段（仍兼容）

没有 `vision` 字段时，旧的扁平字段照常工作：`provider` / `model` / `modelMatch`（exact|substring）/ `baseUrl` / `apiKey` / `apiKeyEnv` / `cost` / `headers` / `defaults.effort` / `defaults.maxTokens`。

## 思考深度（reasoning effort）

API 不传 `reasoning.effort` 时默认为 `medium`，模型跳过深度推理，直接作答——实测会产生臆测性幻觉。默认 `high`（配置 `defaultEffort` 或工具/CLI 的 `effort` 参数可改）：

| effort | reasoning tokens | 结果 | 说明 |
| --- | --- | --- | --- |
| medium（API 默认） | ~56 | completed | 快但浅，易臆测 |
| high（默认） | ~1034 | completed | 细节丰富、明确标注不确定处，推荐 |
| xhigh / max | ~1500+ | 易 incomplete | 预算被 reasoning 吃光，需 `--max-tokens` 提高到 8000+ |
| off / minimal | 省略 reasoning 字段 | — | zen 网关把这两个值映射为 null（直接传会 HTTP 400） |

## 工作流程

1. 按上方 Trigger 确认条件已满足（或配置了 forceVisionBridge）
2. 拿到图片路径（Windows 路径会被自动转换为 `/mnt/<盘符>/...`）
3. **显式构造 `--prompt`**：根据用户的具体意图（描述/转录文字/对比/识别等）编写提示词，直接作为 `--prompt` 传入（省略会报错，见用法）
4. 运行，将 stdout 的模型描述转述给用户
5. 向用户说明这是单次识别结果；如果准确性关键，可用其他视觉模型交叉验证（配置多个 vision.models 条目，`--model <name>` 切换，或 `--model kimi-k2.7-code` 类 registry 模型）

## 实现细节

- **核心**：`lib/`（纯 TypeScript，Node 内置 fetch，无 python/无第三方运行时依赖）；工具与 CLI 共用
- **API**：OpenAI Responses API —— `POST {baseUrl}/responses`；模型条目里的 `api` 字段只是 pi 的协议偏好，不构成限制（zen 网关对声明为 openai-completions 的模型同样服务 `/responses`，kimi-k2.7-code 实测可用）
- **认证**：pi-registry 条目 → `~/.pi/agent/auth.json` 里该 provider 的 `key`；responses 条目 → `apiKey`（`$ENV_VAR` 或字面量）
- **请求体**：`input_text`（提示词）+ 每图一个 `input_image`（`data:image/<mime>;base64,...`），base64 只在内存与本次 HTTPS 请求中出现，不进主模型上下文、不落 session 历史
- **输出**：从 `output[]` 提取 `output_text`；stderr 打印机器可读行（config/entry/type/model/baseUrl/key/usage/cost）

## 排查

| 症状 | 原因 / 处理 |
| --- | --- |
| `pi-vision-helper refused: the active main model ... can see images itself` | 主模型是 VLM，工具门控拒绝委托；确认需要后配置 `forceVisionBridge: true` |
| `vision.active 'x' not found in vision.models` | `vision.active` 名字拼错；报错里会列出可用名 |
| `defaultEffort must be one of ...` / `maxTokens must be between 256 and 32768` | 配置值非法；按报错范围修正 |
| `cannot determine MIME type for ...` | 图片扩展名不在支持列表（png/jpg/jpeg/jfif/gif/webp/bmp/heic/avif）；改扩展名或重命名 |
| `request to ... timed out after ...ms` | 超时（默认 60000，工具内默认 300000）；调大 `timeoutMs` |
| `no vision-capable luna model found` | pi-registry 里没有 luna；配置 vision.models，或加一个 pi-registry 条目 |
| `no model matched in provider` | Provider/Model 模糊匹配落空；用完整名，或检查 models-store.json |
| `apiKey references $X which is not set` | 环境变量未设置；`export X=...` 后再跑 |
| `no API key` | auth.json 缺该 provider 的 key，或 responses 条目没给 apiKey |
| `responses model requires 'baseUrl'/'model'/'apiKey'` | responses 条目缺必填字段 |
| `HTTP 400` | effort=off/minimal 直传会触发（已自动省略 reasoning 字段）；其余 400 多为上游限制 |
| `HTTP 400/500` | 网关/上游对图片输入有限制（历史 issue），换模型或换 baseUrl 验证 |
| 超时 | 调大 `timeoutMs`（默认 60000，工具内默认 300000）；Esc 可取消在途请求 |
| `enabled=false` | 配置总开关关闭；删除或改 true |
