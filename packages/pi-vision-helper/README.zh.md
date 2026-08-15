# pi-vision-helper（中文文档）

> English docs: [README.md](./README.md)

主模型没有视觉能力时，pi 的视觉理解委托包：把图片识别/描述/分析路由到一个**可配置的视觉模型**（OpenAI Responses API）。核心为纯 TypeScript（`lib/`），**单一 runtime、无 python 依赖**。

- **零配置可用**：默认搜索 **pi-registry**——`~/.pi/agent/models-store.json` 中第一个 `input` 含 `image` 的 `luna` 模型（当前为 `gpt-5.6-luna` / `opencode-go`），API key 取自 `~/.pi/agent/auth.json`。
- **配置驱动**：`vision.models[]` 可混合 `pi-registry` 条目（模糊匹配 Provider/Model，走 pi 鉴权）与 `responses` 条目（自定义 baseUrl + `$ENV_VAR`/字面量 apiKey）；`vision.active` 指定激活模型；`enabled` / `forceVisionBridge` / `maxTokens` / `timeoutMs` / `systemPrompt` 调节行为。

包结构：

```text
pi-vision-helper/
├── package.json                    # pi manifest：extensions + skills
├── lib/                            # 核心（工具与 CLI 共用）：config、registry、vision
│   ├── config.ts                   # 配置解析 + schema 归一化
│   ├── registry.ts                 # models-store / auth.json 访问 + 模糊匹配
│   └── vision.ts                   # 目标解析 + Responses API 请求往返
├── extensions/
│   └── pi-vision-helper.ts         # 注册 `pi-vision-helper` 工具（进程内直调）
├── skills/
│   └── pi-vision-helper/
│       ├── SKILL.md                # 触发条件、配置 schema、排查表
│       └── scripts/
│           └── vision.ts           # 手动排查 CLI（bun 直跑），共用 lib/
├── README.md                       # 英文文档
└── README.zh.md                    # 本文档
```

## 安装

```bash
pi install npm:@yceachan/pi-vision-helper
```

或作为本地路径加入 `~/.pi/agent/settings.json`：

```json
"~/work/pi-agent-harness/extensions/mono/packages/pi-vision-helper"
```

改完 `/reload`（或重启 pi）热加载。

## 用法

优先使用 `pi-vision-helper` 工具（schema 强制 `images` 与 `prompt`）：

```text
pi-vision-helper images=[路径1, 路径2] prompt="详细描述这张图" effort=high max_tokens=4096
```

- `images`：图片路径，支持 Windows（`C:\...`）与 WSL（`/mnt/...`）路径、多图
- `prompt`：**必填**，必须按用户具体意图显式构造（描述/转录/对比等），禁止省略
- `effort`：思考深度（默认 `high`；`medium` 易幻觉；`xhigh`/`max` 需把 `max_tokens` 提到 8000+；`off`/`minimal` 省略 reasoning 字段——zen 网关直传会 HTTP 400）
- `max_tokens`：输出预算含 reasoning（默认取配置 `maxTokens`，未配置 4096，范围 256–32768）

手动 CLI（同一核心，排查用）：

```bash
bun packages/pi-vision-helper/skills/pi-vision-helper/scripts/vision.ts img.png \
  --prompt "描述这张图" --model luna-customer --effort high --max-tokens 4096
```

## 配置

配置文件按优先级取第一个存在的：

| 优先级 | 路径 | 作用域 |
| --- | --- | --- |
| 1 | `--config <path>`（CLI 参数） | 显式指定；文件缺失 = 直接报错 |
| 2 | `$PI_VISION_HELPER_CONFIG` | 环境变量显式指定；文件缺失 = 直接报错 |
| 3 | `$CWD/.pi/vision-helper.json` | 项目级（可入仓库，按项目共享） |
| 4 | `~/.pi/agent/pi-vision-helper.json` | 用户级（全局默认） |

完全无配置文件 = 默认行为：搜索 pi-registry，使用**最先找到的 provider 里第一个匹配到的 luna 模型**（`input` 含 `image`）。

### 完整配置示例

```jsonc
{
  // ── 全局开关 ──────────────────────────────────────────────────────────
  "enabled": true,                  // 总开关；false = 工具/CLI 拒绝运行
  "forceVisionBridge": false,       // true = 主模型即使是 VLM 也允许委托
                                    //   （默认仅限无视觉主模型）
  "maxTokens": 4096,                // 默认最大输出 token（含 reasoning）；
                                    //   工具/CLI 参数可覆写
  "timeoutMs": 60000,               // 默认单次视觉调用超时（毫秒）；
                                    //   pi 工具未配置时回退 300000
  "systemPrompt": "",               // 自定义系统提示词；
                                    //   空 = 内置默认（要求逐字转录等）

  // ── 模型与 API ────────────────────────────────────────────────────────
  "vision": {
    "active": "luna",               // 激活的模型名；缺省 = models[] 第一条；
                                    //   models[] 为空 = 旧版扁平字段 / 默认 luna 搜索
    "models": [
      {
        // ① pi-registry 条目 —— 复用 pi 模型目录与 pi 鉴权
        "name": "luna",             // 唯一名称（vision.active / CLI --model 用）
        "type": "pi-registry",      // "pi-registry" | "responses"
        "Provider": "opencode-go",  // 模糊匹配 models-store.json 里的 provider
                                    //   （大小写不敏感；无匹配 = 报错并列出可用 providers）
        "Model": "gpt-5.6-luna",    // 模糊匹配该 provider 下的模型，优先 input 含
                                    //   image 的；缺省 = 首个 vision-capable（luna 优先）
        // 可选覆盖（pi-registry）：
        // "cost": { "input": 0.1, "output": 0.6,
        //           "cacheRead": 0.01, "cacheWrite": 0.125 },  // 美元/每 M token；
        //                                                      //   缺省 = store 条目成本
        // "headers": { "X-Foo": "bar" }                        // 附加请求头
      },
      {
        // ② responses 条目 —— 任意兼容 OpenAI Responses API 的端点
        "name": "luna-customer",
        "type": "responses",
        "baseUrl": "https://opencode.ai/zen/go/v1",
                                    // 必填：端点根（自动拼 /responses）
        "apiKey": "$VISION_API_KEY",// 必填：$ENV_VAR 引用或字面量 key
        "model": "gpt-5.6-luna",    // 必填：字面模型 id（不做 registry 匹配）
        // 可选（responses）：
        // "cost": { "input": 0.1, "output": 0.6 },            // 缺省 = 0（不计成本）
        // "headers": { "X-Foo": "bar" }                       // 附加请求头
      }
    ]
  }
}
```

### 字段参考

#### 顶层

| 字段 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- |
| `enabled` | bool | `true` | 总开关。`false` = 工具返回"已禁用"文本、CLI 报错退出 |
| `forceVisionBridge` | bool | `false` | 解除触发限制：主模型是 VLM 也允许委托 |
| `maxTokens` | number | 4096 | 工具/CLI 未传时的默认 `max_output_tokens`（含 reasoning） |
| `timeoutMs` | number | 60000 | 默认单次调用 HTTP 超时（毫秒；pi 工具未配置时用 300000） |
| `systemPrompt` | string | `""` | 替换内置视觉助手指令；`""` 保持默认 |
| `vision` | object | — | 模型选择块（见下）；缺省 = 旧版扁平字段 / 默认 luna 搜索 |

#### vision

| 字段 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- |
| `active` | string | 首条 | 激活模型条目名；未知名回退首条 |
| `models` | array | `[]` | 模型条目（按优先级排列）；空 = 旧版扁平字段 / 默认 luna 搜索 |

#### 模型条目

字段随 `type` 而定：

| 字段 | `pi-registry` | `responses` | 含义 |
| --- | --- | --- | --- |
| `name` | ✓ | ✓ | 条目唯一名（`active` / CLI `--model` 用）；缺省 = `<Provider>/<Model>` 或 `<model>` |
| `type` | ✓ | ✓ | `"pi-registry"` = 复用 pi 目录与鉴权；`"responses"` = 自定义端点 |
| `Provider` | ✓ | — | 模糊匹配 models-store.json 里的 provider（大小写不敏感，`provider` 亦接受）；无匹配 = 报错并列出可用 providers |
| `Model` | ✓ | — | 模糊匹配该 provider 下的模型（`model` 亦接受），优先 vision-capable；缺省 = 首个 vision-capable（luna 优先） |
| `baseUrl` | — | ✓ | 端点根，自动拼 `/responses` |
| `apiKey` | — | ✓ | `$ENV_VAR` 引用（调用时展开，环境未设置 = 报错）或字面量 key |
| `model` | — | ✓ | 字面模型 id，不做 registry 查找 |
| `cost` | ✓ | ✓ | 美元/每 M token `{input, output, cacheRead, cacheWrite}`；覆盖 store 成本 / 缺省 0 |
| `headers` | ✓ | ✓ | 并入请求的附加 HTTP 头 |

#### 模糊匹配

确定性顺序：精确（忽略大小写）> 候选包含查询串 > 查询串包含候选 > **无匹配 = 报错**。
绝不静默选第一个候选——那会把未知 provider 路由到错误后端并真实扣费。

### 旧版扁平字段（仍兼容）

没有 `vision` 块时，旧的单模型字段照常工作：

```jsonc
{
  "provider": "opencode-go",        // registry provider（缺省：第一个 provider）
  "model": "gpt-5.6-luna",          // registry 模型 id（模糊；缺省：luna 搜索）
  "modelMatch": "exact",            // "exact" | "substring"
  "baseUrl": "https://...",         // 覆盖 / 自定义端点
  "apiKey": "$VISION_API_KEY",      // key 覆盖（$ENV_VAR 或字面量）
  "apiKeyEnv": "VISION_API_KEY",    // 另一种形式：存 key 的环境变量名
  "cost": { "input": 0.1, "output": 0.6 },
  "headers": { "X-Foo": "bar" },
  "defaults": { "effort": "high", "maxTokens": 4096 }
}
```

### 生效优先级

工具/CLI 参数 > 配置文件 > pi-registry（models-store.json + auth.json）> 内置默认
（luna / `high` / 4096）。key 专用优先级：条目 `apiKey` > 条目环境变量 > `auth.json[provider].key`。

## 工作原理

- **请求**：OpenAI Responses API——`POST {baseUrl}/responses`，`input_text`（提示词）+
  每图一个 `input_image`（`data:<mime>;base64,...`）。base64 字节只存在于内存与那次 HTTPS
  请求中——不进主模型上下文、不落 session 历史。models-store.json 里模型条目的 `api` 字段
  仅作参考：zen 网关对声明为 openai-completions 的模型同样服务 `/responses`（kimi-k2.7-code
  实测可用）。
- **effort**：`off`/`minimal` 直接省略 `reasoning` 字段（zen 网关映射为 null，直传会
  HTTP 400 `invalid_prompt`）。
- **用量与成本**：工具通过 pi 的 Usage 上报 token 与美元成本——registry 条目成本为默认，
  可逐条目 `cost` 覆盖，未知时记 0。
- **报错**：配置/registry 问题一律响亮失败并给出可操作信息（列出可用 providers/models、
  环境变量名、所读配置文件路径）——无静默降级。
