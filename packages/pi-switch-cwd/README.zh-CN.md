# pi-switch-cwd

**[English](./README.md) | 简体中文**

pi 扩展：**`/cwd`**——切换 session 工作目录，session 文件随之迁移。

## 为什么需要它

长程对话经常从大型资料目录中的讨论、研究阶段，进入具体工程目录中的实现阶段。如果不切换 session，每次执行 bash 都需要手工 `cd $CWD`，持续消耗上下文 token。

执行 `/cwd` 后，bash/read/write 工具、AGENTS.md 上下文和 skills 会自动指向新目录；`pwd` 可直接得到当前工程目录。

## 用法

```text
/cwd                显示当前 cwd
/cwd <path>         切换到 <path>（相对路径基于当前 cwd；~ 展开为 $HOME；
                    目录不存在时使用 mkdir -p 创建）
```

- Tab 补全只显示目录；默认隐藏点目录，输入以 `.` 开头时显示。
- 目标目录等于当前 cwd 时不执行操作；目标是文件时报错。
- 切换前等待 agent 空闲；如果 agent 正在流式输出，先停止当前输出。

## 工作原理

pi 没有“原地修改 cwd”的 API。工具、上下文和 skills 都绑定到 cwd，只有替换 session runtime 时才会重建。因此 `/cwd` 通过以下步骤迁移 session：

1. 从内存序列化 session，重写 header 的 `cwd` 字段，保留相同 id 和全部 entries。
2. 将 session 写入目标 cwd 对应的 session 目录：`~/.pi/agent/sessions/--<encoded path>--/`。
3. 通过 `switchSession` 替换 runtime，自动重建新 cwd 对应的服务。
4. 切换成功后删除旧 session 文件。

**Session 身份保持不变**：id 和完整历史不变；往返切换不会累积 session 副本。如果其他扩展否决切换，旧文件保持不动。副作用是：该 session 只会出现在当前所在目录的 `/resume` 列表中。

## 长程 session 与提示词前缀缓存

`/cwd` 会保留对话，但**不会保留完全相同的 provider prompt prefix**。长程 session 依赖 prompt cache 时，需要区分“上下文仍然存在”和“缓存前缀仍然命中”。

| 行为边界 | 实际行为 |
| --- | --- |
| 执行 `/cwd` 时 | 不发起模型请求，因此命令本身没有 cache-read，也不产生模型 token 成本。 |
| Session 状态 | Session id、对话 entries、分支和 compaction 状态全部保留；模型的逻辑上下文没有被删除。 |
| 切换后的第一次模型请求 | Pi 重建绑定 cwd 的 runtime 服务。System prompt 至少会改变 `Current working directory`；项目上下文文件、skills、settings、extensions、active tools 或 tool schemas 也可能变化。因此序列化后的 prompt 会在历史对话之前发生分歧。 |
| Cache miss 范围 | 取决于 provider。Provider 可能复用首个变化 token 之前的公共前缀，但变化点之后的对话历史通常不能在本次请求中继续作为同一缓存前缀复用。应将其理解为一次 cold/mixed-cache turn，而不是上下文丢失。 |
| 新 cwd 下的后续请求 | 新 prompt prefix 可以重新预热并恢复正常缓存命中。稳定切换后，通常只有第一次模型 turn 承担迁移成本。 |
| 切回旧 cwd | 只有旧 provider cache 尚未过期、项目资源与工具 schema 未变化，并且路由/session affinity 命中原缓存时，旧前缀才可能再次命中；这属于优化机会，不是行为保证。 |
| Provider 不支持 prompt cache | 不存在可观察的缓存命中损失；重建后的 system prompt 和项目资源仍会改变模型行为。 |

保持相同的 session id、cache key 或 session-affinity 值，不能绕过内容前缀匹配。这些值可以帮助请求路由到对应缓存，但 prompt 内容仍须满足 provider 的匹配规则。

长程 session 建议：

- 优先进行单向阶段切换，例如“资料目录研究 → 工程仓库实现”；当缓存延迟或输入成本重要时，避免在多个项目之间频繁往返。
- 如果保留的对话已经很长，且本次切换是稳定的阶段边界，可先执行 `/compact`，再执行 `/cwd`，以缩小新 cwd 下第一次未缓存请求的输入。
- 只需短暂跨目录操作，并且保留当前 prompt prefix 比加载目标项目的 context、skills、settings、extensions 和 cwd-bound tools 更重要时，使用绝对路径而不是 `/cwd`。

## 安装

```bash
pi install npm:@yceachan/pi-switch-cwd
```

## 开发

```bash
bun install                 # 安装开发依赖
bunx tsc                    # 类型检查
bun cwd-utils.test.ts       # 纯函数单元测试
./e2e-test.sh               # 真实端到端测试（tmux + 真实 pi，需要配置默认模型）
```

## 许可证

MIT
