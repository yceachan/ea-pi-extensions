# v0.1.2

首个新包发布：pi-better-mermaid；CI 发布循环幂等化、文档补齐容灾 runbook。

## feat

- pi-better-mermaid：tool call harness
  - 用工具约束 agent 产出 mermaid 的「写-查-产出」流程：mmdc 渲染校验 + lint 硬规则，结构化错误反馈、最多 3 次重试
  - 内嵌官方 mermaid-skills，向 agent 提供各图类型知识
  - 集成作者 mermaid 偏好与经验沉淀：浅色 rgb rect 块
  - 能力检测归档：16 类图型全部通过（`.mmd` 裸源 + `.svg` 产物 + 索引 README），替换原 evals.json

## fix

- pi-better-mermaid：弃用 `eventmodel`（mermaid@11.15.0 渲染错误页），能力清单移除；工具增加 SVG 内容检查，杜绝错误页误判通过（门禁假阳性修复）

## chore

- pi-better-mermaid 改为 public，作为可发布包纳入 lockstep
- 新增 gcm 提交助手（type/scope 校验、模糊 scope 选择），mono-release/mono-sync 打磨

## ci

- publish.yml 幂等重跑：目标版本已在 registry 则跳过，部分失败可直接重跑工作流恢复，无需手动补发

## docs

- 新增 tag 回退与 CI 容灾 runbook（docs/tag回退与CI容灾.md）
- 发行版本控制策略补充 CI 失败恢复矩阵；提交规范与 README 对齐

## eval

> ![note]
> [eval](packages/pi-better-mermaid/skills/better-mermaid/evals)

e.g.
[01-sequenceDiagram.svg](packages/pi-better-mermaid/skills/better-mermaid/evals/01-sequenceDiagram.svg)
