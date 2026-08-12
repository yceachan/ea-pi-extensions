---
name: oc-go-luna-vision
description: Use when the main model lacks vision capability (opencode-go provider; its input list in models-store.json has no "image") but the user asks to describe, analyze, or recognize the content of an image, photo, screenshot, or picture — including Windows paths (C:\...) and WSL paths (/mnt/c/...). Sends the image(s) to the gpt-5.6-luna vision model and returns a detailed description (Chinese by default).
---

# oc-go-luna-vision

> **优先使用 `oc-go-luna-vision` 工具**（`pi-oc-go-luna-vision` 包注册，参数 schema 强制 `images` 与 `prompt` 必填，直接传参即可）。本 skill 是工具的文档层与兜底方案：承载触发条件、参数语义与排查知识；两者调用同一个 `scripts/vision.py`，行为一致。

## 何时使用（Trigger）

满足以下条件时激活本 skill：

1. 当前 provider 是 **opencode-go**（`~/.pi/agent/settings.json` → `defaultProvider`）
2. 主模型不支持图片 —— 检查 `~/.pi/agent/models-store.json` 中当前模型的 `input` 列表不含 `"image"`
3. 用户要求识别/描述/分析图片内容，或给出图片路径

常见无视觉主模型：`deepseek-v4-flash`、`deepseek-v4-pro`、`glm-5.1`、`glm-5.2`、`hy3`、`minimax-m2.7`、`qwen3.7-max` 等。

## 用法

> ⚠️ **`--prompt` 是必填参数**：主模型必须根据用户的具体意图显式构造提示词，禁止省略。省略时脚本直接报错退出（视为 skill 未正确激活）。

脚本位于本 skill 目录的 `scripts/vision.py`，以下命令相对于 skill 目录执行（工具已封装同一脚本，手动运行仅用于排查）：

```bash
# 必须显式传入提示词
python3 scripts/vision.py "C:\Users\yceachan\Pictures\profile-photo.jpg" --prompt "请详细描述这张图片的内容，包括外貌、表情、服装、背景、光线等细节。用中文回答。"

# 自定义提问
python3 scripts/vision.py "图片路径" --prompt "图中有什么文字？请逐字转录"

# 多张图片一起分析
python3 scripts/vision.py "img1.jpg" "img2.png" --prompt "对比这两张图的异同"

# 查看原始 JSON 响应
python3 scripts/vision.py "图片路径" --prompt "描述这张图" --json
```

其他选项：`--model <id>` 覆盖模型、`--effort <off|low|medium|high|xhigh|max>` 控制思考深度（默认 `high`）、`--max-tokens <n>` 控制输出预算（默认 4096）。

## 思考深度（reasoning effort）

API 不传 `reasoning.effort` 时默认为 `medium`，模型跳过深度推理，直接作答——实测会产生臆测性幻觉。脚本默认 `high`：

| effort | reasoning tokens | 结果 | 说明 |
| --- | --- | --- | --- |
| medium（API 默认） | ~56 | completed | 快但浅，易臆测 |
| high（脚本默认） | ~1034 | completed | 细节丰富、明确标注不确定处，推荐 |
| xhigh / max | ~1500+ | 易 incomplete | 预算被 reasoning 吃光，需 `--max-tokens` 提高到 8000+ |

## 工作流程

1. 按上方 Trigger 确认条件已满足
2. 拿到图片路径（Windows 路径会被自动转换为 `/mnt/<盘符>/...`）
3. **显式构造 `--prompt`**：根据用户的具体意图（描述/转录文字/对比/识别等）编写提示词，直接作为 `--prompt` 传入（省略会报错，见用法）
4. 运行脚本，将 stdout 的模型描述转述给用户
5. 向用户说明这是 luna 单次识别结果；如果准确性关键，可建议用其他视觉模型交叉验证（如 `kimi-k2.7-code`、`qwen3.6-plus`、`minimax-m3`，它们在 models-store 中 `input` 含 `image`）

## 实现细节

- **模型**：`gpt-5.6-luna`（`~/.pi/agent/models-store.json` 中自动查找，`input` 含 `image` 且 id 含 `luna`）
- **API**：OpenAI Responses API —— `POST {baseUrl}/responses`（baseUrl 从 models-store 读取，当前 `https://opencode.ai/zen/go/v1`）
- **认证**：`~/.pi/agent/auth.json` → `opencode-go.key`
- **请求体**：

  ```json
  {
    "model": "gpt-5.6-luna",
    "input": [{
      "role": "user",
      "content": [
        {"type": "input_text", "text": "<提示词>"},
        {"type": "input_image", "image_url": "data:image/jpeg;base64,<BASE64>"}
      ]
    }],
    "max_output_tokens": 4096,
    "reasoning": {"effort": "high"}
  }
  ```

- **响应**：从 `output[]` 中提取 `type == "output_text"` 的 `text` 字段；进度信息（模型、token 用量）打印到 stderr
