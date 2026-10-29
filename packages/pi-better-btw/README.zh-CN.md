<p>
  <img src="banner.png" alt="pi-better-btw" width="1100">
</p>

# @yceachan/pi-better-btw

**[English](README.md) | 简体中文**

> [!note]
>
> 本package是对 [nicobailon/pi-side-chat](https://github.com/nicobailon/pi-side-chat) 的维护型 fork —— 原作者 **Nico Bailon**，由 **yceachan** 扩展并在[ea-pi-extensions](https://github.com/yceachan/ea-pi-extensions) 中维护。感谢 **[De0ta](https://github.com/De0ta)** 在 [PR #5](https://github.com/yceachan/ea-pi-extensions/pull/5) 中贡献独立模型控制、布局与主题化 UI。

## TL;DR

**把当前会话 fork 到一个旁路会话（btw）中，主线 agent 继续干活。**

[![npm version](https://img.shields.io/npm/v/@yceachan/pi-better-btw?style=for-the-badge)](https://www.npmjs.com/package/@yceachan/pi-better-btw)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)

需要 Pi 1.4 或更新版本。

```bash
pi install npm:@yceachan/pi-better-btw
#in pi tui
> /btw  || or Alt+W
```

你在处理一个较长任务时，想顺便问点小事又不想打断主线——查一个 API 细节、验证一个思路、搜点东西，或者看看主线 agent 在干什么。打开 BTW TUI Overlay，提问，再隐藏浮层。主线线程完全不受打扰。

<img src="preview.jpg" alt="pi-better-btw 旁路聊天预览" width="1100" />

## Feat

> [!note]
>
> **Thats Why Called Better-Btw**
>
> Author 尝试过[nicobailon/pi-side-chat](https://github.com/nicobailon/pi-side-chat)  与[dbachelder/pi-btw](https://github.com/dbachelder/pi-btw)，均是简单从main 主线fork，如果 agent on turn ,均会出现尝试推进主线的情况，see[[feat request\] btw aside-session self-cognition — the side chat must not continue the main session's work · Issue #5 · nicobailon/pi-side-chat](https://github.com/nicobailon/pi-side-chat/issues/5)。
>
> 于是精心开发了如下feat

- `Aside-Agent self-Cognition` ：注入主线上下文，便于对工程主线 ask a btw question；同时做出精心的上下文工程优化，强化辅助Agent认知，**避免全量主线上下文的tool call trace干扰认知，与主线竞争推进工程**。同时保留主线共享前缀，实现较好的缓存命中。

- `Prompt pack`: 所有提示此注入均文档化+ `bundle`/`$PI_HOME` / `$CWD`三级覆盖。

- `TUI scroll,select,copy` ：在TUI-overlay 自订阅鼠标/hotkey事件，实现滚屏 ，text选中 ， Ctrl +C 复制功能

- `Readonly/Edit Mode` : 默认只读来回应btw question，如果你希望Agent顺手做些小修改，Ctrl + t To Edit Mode.

  - ToolAllowList : bundle + config.json custom

  | 模式 | 工具                                                         |
  | ---- | ------------------------------------------------------------ |
  | 只读 | `read`、`grep`、`find`、`ls` ;`peek_main`  ;`config.json.readOnlyExtensionAllowlist` |
  | 编辑 | `read`、`bash`、`edit`、`write`                              |

## Usage

用 `/btw`（别名 `/side`）或 `Alt+W`（同时负责后台/显示切换）打开旁路会话。提问后按 `Enter`。

生成中第一次按 `Esc` 打断当前 turn，并留在聊天；turn 结束后再按 `Esc` 隐藏浮层，保留 session、历史、草稿和滚动位置。在模型、思考级别选择器或帮助页中，`Esc` 先返回聊天。`Alt+W` 隐藏或恢复浮层，运行中的生成继续进行。仅 `Alt+N` 销毁当前旁路 session 并开启空白会话；不再提供 `/btw-close` 和 `Alt+R`。

主界面默认页脚在模型旁显示 `[● side chat]`：生成中为黄色，空闲时为绿色，隐藏期间仍可见，关闭后消失。不接管自定义页脚，而是提供标准 keyed status 供其显示。

旁路模型和思考级别最初继承主会话，之后独立选择，并在当前 Pi 进程中记忆。`Ctrl+P` / `Ctrl+Shift+P` 按 Pi 范围循环模型，`Shift+Tab` 循环支持的思考级别，`Alt+P` 可替代反向模型切换。这些操作遵循 Pi 的按键配置。`Alt+M` 打开可搜索模型列表，`Alt+T` 打开思考级别选择。切换前用 `Alt+S` 停止当前生成，不会修改主会话设置。

无边框面板跟随主主题及终端颜色，与主背景保持轻微层次差异。用户消息有带留白和左侧细竖线的卡片，复制时不包含装饰线；AI 回复复用 Pi 原生 Markdown、代码及思考内容渲染，不单独分色；思考和工具详情由 [quiet 显示开关](#btw-quiet)控制。内收输入框从三行按需增长，最多显示五行正文并保持光标可见；`›` 和“问点什么…”仅作显示，不进入草稿。常用提示在空间允许时压缩为一行；空草稿按 `?` 查看完整自适应快捷键页。

| 快捷键 | 作用 |
| ------ | ---- |
| `Alt+W` | 打开（关闭时）/ 后台化（显示时）/ 恢复（隐藏时） |
| `Ctrl+T` | 切换只读 / 编辑模式 |
| `Alt+N` | 销毁当前 session 并开启空白会话 |
| `Alt+E` | 导出对话记录到 `$CWD/.agents/eval/pi-better-btw-<timestamp>.md` |

在Readonly Mode(default),只读车道是**强制的**：越权调用工具会被硬阻断并注入prompt；第二次违规会升级措辞并中止该轮，提示（`🚧 lane blocked` 状态行）。已执行但失败的只读调用会被 `afterToolCall` 备注再次归位。编辑模式（`Ctrl+T`）不受影响。

**窥视主线 agent** —— `peek_main` 工具读取主线会话的近期活动。

```text
What is the main agent doing right now?
What changed since I opened this side chat?
```

**后台化** —— 默认浮层居中，占终端 90% 宽、最多 92% 高。`Alt+W` 隐藏浮层并交还主线键盘，agent 继续流式输出，再按 `Alt+W` 恢复。

**实时布局** —— `Ctrl+Alt+←` 全屏，`Ctrl+Alt+↑` 原始较小顶部居中窗口（85% 宽），`Ctrl+Alt+↓` 较大居中浮窗，`Ctrl+Alt+→` 全高右半屏。在选择器和帮助页中也可切换。保留 agent、历史和草稿；由于折行变化，仅清除当前文本选区。布局随终端缩放，并为多行编辑器保留实际高度。

**消息跳转** —— `Ctrl+↑`/`Ctrl+↓` 跳转到用户提问或最终 AI 回复，跳过工具记录，并遵循 Pi 的 `tui.altScreen.previousPrompt`/`nextPrompt` 自定义绑定。流式 AI 文本同样参与跳转，不改变草稿和运行中的 agent。

**滚动历史** —— `PgUp`/`PgDn` 整页滚动，`Shift+↑`/`Shift+↓` 按行滚动，鼠标指针悬停于聊天区域时滚轮滚动。离开最新消息时，标题栏出现 `[↑N]` 指示器。流式期间视口跟随底部；一旦你向上滚动就冻结内容锚定（新行增长滚动偏移而不是滑动可见内容），回到底部或新消息后恢复跟随。

**鼠标选择 + 快捷键复制** —— 拖拽选择聊天文本（反色高亮）；双击选择整行。复制仅限快捷键：`Ctrl+C` / `Ctrl+Shift+C` 通过原生剪贴板级联（`wl-copy`/`xclip`，OSC 52 兜底）复制保留的选择；选择保持高亮，可重复按复制。拖拽不碰剪贴板，鼠标交互不阻塞事件循环。Pi 全屏模式下，浮层使用 Pi 的标准鼠标分发与拖拽捕获接口；点击输入区可定位光标。后台化或关闭浮层后，Pi 主界面的鼠标操作保持可用。常规模式下，扩展自管的鼠标上报跟随浮层*可见性*，后台化时恢复终端原生选择。

**对话导出** —— `Alt+E` 把 btw 历史（fork 上下文、framing 块、对话、流式中内容）导出为 `$CWD/.agents/eval/pi-better-btw-<timestamp>.md` 的 markdown 诊断产物，便于调试功能开发。

## 快捷键

| 按键 | 作用 |
| ---- | ---- |
| `Alt+W` | 打开（关闭时）/ 后台化（显示时）/ 恢复（隐藏时） |
| `Enter` | 发送消息 |
| `Esc` | 生成中打断当前 turn，空闲时隐藏；从选择器或帮助页返回聊天 |
| `?` | 完整快捷键页（仅空草稿） |
| `Ctrl+Alt+←` / `↑` / `↓` / `→` | 全屏 / 小浮窗 / 大浮窗 / 右半屏 |
| `Ctrl+↑` / `Ctrl+↓` | 上一条 / 下一条消息（Pi 绑定） |
| `Ctrl+P` / `Ctrl+Shift+P` | 向前 / 向后循环旁路模型（Pi 绑定） |
| `Alt+P` | 向后循环模型（替代按键） |
| `Shift+Tab` | 循环支持的思考级别（Pi 绑定） |
| `Alt+M` / `Alt+T` | 搜索模型 / 选择思考级别 |
| `Alt+S` | 停止当前生成，保留会话 |
| `Alt+N` | 销毁当前 session 并开启空白会话 |
| `Alt+E` | 导出 btw 对话历史到 `$CWD/.agents/eval/pi-better-btw-<timestamp>.md` |
| `Ctrl+T` | 切换只读 / 编辑模式 |
| `PgUp` / `PgDn` | 整页滚动历史 |
| `Shift+↑` / `Shift+↓` | 按行滚动 |
| 鼠标滚轮 | 指针位于聊天区域时滚动 |
| 鼠标拖拽 | 选择聊天文本（反色高亮）；松开不自动复制 |
| 双击 | 选择整行 |
| `Ctrl+C` / `Ctrl+Shift+C` | 复制当前鼠标选择（仅快捷键；选择保留到下次点击，可重复复制） |

## 命令参考

### `/btw`

打开旁路会话浮层。`/side` 的别名。

### `/side`

打开旁路会话浮层（保留上游命令名作为兼容别名）。

### `/btw-quiet`

在主编辑器或旁路编辑器中切换旁路 quiet 显示。**默认开启**：思考正文折叠为 `Thinking...`；工具调用保留一行有用信息，例如 `read src/index.ts`、`bash bun run test`，成功结果不另占一行，失败保留提示。标题带 `[Quiet]`。关闭后展开思考、工具参数和完整文本结果，立即作用于已有历史及当前流式回复。

两个入口共用一个开关，当前 Pi 进程内记忆；首次打开前也可设置，隐藏恢复与 `Alt+N` 新建时沿用。旁路生成中也可执行，命令在本地处理。切换时回到最新内容并清除文本选区；主线自身的显示、模型上下文和导出记录保持原样。

### `peek_main`

仅旁路 agent 可用。

| 参数 | 类型 | 说明 |
| ---- | ---- | ---- |
| `lines` | integer | 最多检查条数（默认 20，最大 50） |
| `since_fork` | boolean | 仅显示旁路会话打开之后的活动 |

## 配置

pi-better-btw 从三个位置按优先级递增读取 `config.json` —— 每层只覆盖它实际定义的键：

| 层 | 位置 |
| -- | -- |
| Bundle（默认） | 扩展目录下的 `config.json` —— 随 git 跟踪，随发布包分发 |
| 用户 | `~/.pi/agent/pi-better-btw/config.json` |
| 项目 | `<project>/.pi/pi-better-btw/config.json` |

键：

- `readOnlyExtensionAllowlist` —— 只读车道允许的扩展工具名（车道始终包含内置只读工具 `read`/`grep`/`find`/`ls` 和 `peek_main`）。各层按 bundle → user → project 顺序**取并集**（去重，先到先得）：高层只增不减。
- `readOnlyExtensionAllowlistExclude` —— 从最终列表中移除的工具名，例如用于去掉某个内置默认。
- `promptPack` —— 提示包清单（见下）；按键合并，高层优先。相对路径按所在层目录解析，用户级 manifest 可放在用户配置旁边；绝对路径亦可。

示例（用户或项目层）：

```json
{
  "readOnlyExtensionAllowlist": ["pi-vision-helper", "lens_diagnostics"],
  "readOnlyExtensionAllowlistExclude": ["web_search"]
}
```

### 提示包清单

`promptPack` 把每条注入提示映射到一个 markdown 文件（相对于本层目录，或绝对路径）。所有键均可选——缺失或不可读的键回退到随包的 `prompts/` 默认值（并给出 UI 警告）：

| 键 | 内置默认 | 注入时机 |
| -- | -------- | ---- |
| `promptPack.framing` | `prompts/btw-framing.md` | fork 上下文之后（不作为聊天气泡渲染）——把引用框定为"仅供引用" |
| `promptPack.focusAnchor` | `prompts/btw-focus-anchor.md` | 每轮——"只回答 btw 最新消息" |
| `promptPack.laneReminders.base` | `prompts/lane-reminder-base.md` | 第一次只读违规（`{{tool}}` / `{{count}}`） |
| `promptPack.laneReminders.escalated` | `prompts/lane-reminder-escalated.md` | 第二次违规，中止本轮之前 |
| `promptPack.laneReminders.failedNote` | `prompts/lane-failed-note.md` | 已执行但失败的只读调用之后 |
| `promptPack.laneReminders.preamble` | `prompts/lane-preamble.md` | 只读车道开场白 |

随包的 `config.json` 只读白名单默认只含官方 pi 工具集合（`web_search`、`source_check`、`fetch_content`、`get_search_content`）；第三方工具（pi-lens、context7、vision 等）通过用户层追加。

## 工作原理

扩展克隆当前会话上下文，创建带全部扩展工具的独立 agent 实例，并在 TUI 浮层中渲染。打开命令在浮层挂载后即返回，主输入循环继续处理后续命令；UI 交互独立运行，直到宿主会话清理或 `Alt+N` 重建。隐藏保留 agent 和草稿，`Alt+W` 同时保留正在进行的生成。`Alt+N` 中止并销毁旧 session，以记忆的旁路模型和思考设置开启空白会话。

默认页脚指示器适配公开的 `FooterComponent` 渲染器，不修改已安装的 Pi 文件，也不接管 `setFooter`；扩展退出时恢复渲染器。标准 keyed `setStatus` 在运行中切换自定义页脚时仍然可用。模型行位置依赖 Pi 页脚内部布局，使用真实渲染器回归测试覆盖。

旁路请求走 `modelRegistry.streamSimple`，由 Pi 模型运行时处理认证、请求头和虚拟模型路由。

btw 上下文保留主线的 system prompt 于 system 槽位，并逐字注入 fork 快照，使 btw 请求头成为主线请求的 token 前缀（网关前缀缓存命中）。`forkSurgery`（`srcs/fork-surgery.ts`）让快照的尾部工具交换对网关合法；提示包供给全部注入文本；车道强制在只读模式下包装 `beforeToolCall`/`afterToolCall`（`srcs/side-chat-overlay.ts`）。

主线 agent 的工具执行事件被跟踪以维护已写文件路径集合（`srcs/file-activity-tracker.ts`）；写类工具被包装以在触碰这些路径前警告（`srcs/tool-wrapper.ts`）。

Pi 全屏模式下，`SideChatOverlay.handleMouse()` 接收 Pi 分发的组件局部坐标事件，处理滚轮、捕获聊天区的选择拖拽，并把输入区点击转交给编辑器定位光标。复制仍只由快捷键触发，终端鼠标上报始终归 Pi 管理。常规模式保留原始 SGR 监听器：仅在浮层可见时启用上报，并在鼠标序列进入编辑器前消费它们。

`peek_main` 按需读取当前会话分支并返回紧凑摘要。

## 开发

结构：

```text
.
├── srcs/                  # TypeScript 实现（pi 直接加载 TS，无构建步骤）
│   ├── index.ts           # 扩展入口：命令、快捷键、浮层生命周期
│   ├── config.ts          # 分层配置解析（bundle / user / project）
│   ├── prompt-pack.ts     # 提示包清单加载 + 模板替换
│   ├── fork-surgery.ts    # 共享前缀 fork 快照手术（网关合法尾部）
│   ├── side-chat-overlay.ts  # TUI 浮层、agent 生命周期、车道强制、鼠标路由
│   ├── side-chat-messages.ts # 消息渲染、换行、选择、滚动
│   ├── side-chat-status.ts   # 主界面页脚指示器与 keyed status 兜底
│   ├── side-chat-dialog.ts   # 模型与思考级别选择卡片
│   ├── side-chat-help.ts     # 自适应提示与快捷键页
│   ├── side-chat-input.ts    # 输入卡片、光标与鼠标坐标映射
│   ├── side-chat-panel.ts    # 主主题及终端衍生配色
│   ├── side-chat-layout.ts   # 实时布局预设
│   ├── side-chat-mouse.ts    # 最小 SGR 鼠标解析
│   ├── side-chat-export.ts   # Alt+E 对话导出
│   ├── tool-wrapper.ts       # 写路径重叠警告
│   └── file-activity-tracker.ts
├── prompts/               # 随包提示包默认值（framing、焦点锚、车道提醒）
├── test/                  # bun test 测试套件（配置解析、鼠标选择）
├── config.json            # 内置默认（promptPack 清单 + 只读白名单）
├── banner.png
├── preview.jpg
└── README.md
```

命令：

```bash
bun install         # 安装依赖
bun run typecheck   # tsc --noEmit -p tsconfig.json
bun run test        # 已注册的自动化测试（串行运行，见 bunfig.toml）
```

发布包包含 `srcs/`、`prompts/`、`config.json` 与文档；测试不进入 tarball。开发时把 pi 的扩展加载器指向 `./srcs/index.ts`，改完代码 `/reload` 即可（无构建步骤——pi 直接加载 TypeScript）。

## 限制

- 同一时间只能有一个旁路会话
- 无法在另一个可见浮层之上打开
- 不会把消息合并回主线会话
- bash 重叠检测是启发式的——覆盖常见写模式，非全部
- `peek_main` 是按需读取，非实时
- 需要 Pi 1.4+；全屏鼠标使用 Pi 组件鼠标 API，常规模式保留 SGR 兼容路径

## License

MIT —— 见 [LICENSE](LICENSE)。许可证同时保留两行版权：上游原作者（Nico Bailon）与 fork 修改者（yceachan）。