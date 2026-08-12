# @yceachan/pi-better-mermaid

pi extension + skill: **交付能稳定渲染的 mermaid 图**。捆绑 `better-mermaid` skill（writing-mermaid 规则的同源拷贝），工具对交付的图做 mmdc 语法/渲染校验 + 硬规则 lint，失败返回结构化错误供 agent 循环修复。

## 工作流

```
tool call → agent 读 better-mermaid skill 获取知识(once) → agent 明晰建模意图、产出 mermaid、交付
→ harness 校验（lint ①③⑤+rect → mmdc 渲染）→ check passed 结束；失败返回结构化错误，agent 修改后再次调用
→ 连续 3 次失败返回 exhausted（累计错误 + 重新建模指引），停止重试
```

- **知识注入 (once)**：每个调用序列首次交付前读一次 skill，重试循环中不重读（promptGuidelines 契约）
- **校验门禁三层**：mmdc 语法/渲染（致命）→ harness lint（`;` 禁用 / sequence 有 autonumber / type 与图头一致 / rect rgb 每通道 >200）→ agent 按 skill self-check 自查语义类规则
- **循环**：agent 驱动的多次工具调用；harness 只保留按会话的 3 轮失败计数，其余无状态

## 安装

```bash
npm i -g @mermaid-js/mermaid-cli@11.15.0   # peer 依赖：全局 mmdc（不在包内捆绑）
pi install npm:@yceachan/pi-better-mermaid
```

## 使用

工具：`better-mermaid` — 参数 `intent`（一句话建模意图，必填）、`type`（期望图类型，可选）、`mermaid`（待校验代码，可带 ```mermaid 围栏）。

通过时返回渲染产物 SVG 路径；失败返回行号 + stderr 摘要 + lint 违规 + 尝试计数。

## 设计决策

- [ADR-0001] 循环迭代由 agent 驱动，harness 只做无状态校验 + 3 轮计数（平台无挂起恢复 API）
- [ADR-0002] mmdc 用全局安装，声明为 peerDependency，不捆绑（+300MB puppeteer 不值）
- [ADR-0003] 知识注入 = 捆绑改名 skill（better-mermaid），once 靠提示词契约

见仓库 `.agents/docs/`。

## License

MIT
