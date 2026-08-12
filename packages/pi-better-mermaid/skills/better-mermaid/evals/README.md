# pi-better-mermaid 能力检测归档

检测时间：2025-08-13（mermaid@11.15.0，mmdc @mermaid-js/mermaid-cli@11.15.0）
检测方式：better-mermaid 工具逐类校验（mmdc 渲染 + lint 硬规则），全部通过后归档。
归档内容：本 md（可渲染的 ```mermaid 图块）+ 同名 `.mmd` 裸源（mmdc 复现用）+ `.svg` 渲染产物。

## 结果一览

| #  | 类型                | 尝试 | 建模主题                                        | 备注 |
| -- | ------------------- | ---- | ----------------------------------------------- | ---- |
| 01 | sequenceDiagram     | 1    | 用户请求 → 起草 → 校验 → 重试 → 归档 时序       | box/alt/loop/rect/autonumber |
| 02 | stateDiagram-v2     | 1    | 图交付生命周期状态机                            | 复合态 + choice + notes |
| 03 | classDiagram        | 2    | 包模块结构与依赖                                | namespace/stereotype/基数 |
| 04 | erDiagram           | 1    | 归档数据形状                                    | PK/FK/识别性关系/注释 |
| 05 | flowchart           | 2    | mmdc 校验管线                                   | ELK/子图/扩展形状/粗箭头 |
| 06 | requirementDiagram  | 1    | 编码硬规则追溯                                  | satisfies/verifies/derives |
| 07 | gitGraph            | 1    | 包的分支合并历史                                | cherry-pick/tag/HIGHLIGHT |
| 08 | timeline            | 1    | mermaid 能力演进                                | section 分组 |
| 09 | gantt               | 1    | 检测排期计划                                    | after 依赖/crit/milestone |
| 10 | mindmap             | 1    | 技能知识地图                                    | root(( )) 形状 |
| 11 | C4Context           | 1    | pi 渲染生态上下文                               | 边界/SystemDb/SystemQueue |
| 12 | block               | 2    | 校验产物静态布局                                | columns/复合块/blockArrow |
| 13 | journey             | 1    | 用户画图体验评分                                | section + 评分 |
| 14 | quadrantChart       | 1    | 类型评估 2x2                                    | 16 个数据点 |
| 15 | sankey-beta         | 2    | 类型分发流量                                    | ⚠ 仅 ASCII 节点名 |
| 16 | xychart-beta        | 1    | 各类型校验尝试次数                              | bar + line |

16/16 全部通过；12 类一次通过，4 类（class/flowchart/block/sankey）首败后修复通过。`eventmodeling` 已弃用（11.15.0 渲染错误页，见坑 #8）。

## 01 · sequenceDiagram

意图：用户请求 mermaid 图后，agent 经 skill 起草、mmdc 校验（含失败重试循环）到归档的完整时序，明确用户侧与 agent 侧边界。

```mermaid
sequenceDiagram
    autonumber
    box "用户侧"
        participant User as "用户"
    end
    box "agent 侧"
        participant Agent as "pi agent"
        participant Skill as "better-mermaid skill"
        participant Mmd as "mmdc CLI"
        participant Fs as "归档目录"
    end

    User ->> Agent: "画一张时序图"
    Agent ->> Skill: "读取类型参考"
    Skill -->> Agent: "语法要点 + 硬规则"

    rect rgb(220, 235, 255)
        Agent ->> Mmd: "提交 mermaid 源码"
        alt "渲染通过"
            Mmd -->> Agent: "SVG 产物"
        else "语法或 lint 失败"
            Mmd -->> Agent: "结构化错误"
            loop "最多 3 次重试"
                Agent ->> Agent: "按错误修改"
            end
        end
    end

    Agent -->> User: "交付 mermaid 图块"
    Agent ->> Fs: "归档 .mmd 源文件"
    Fs -->> Agent: "ok"
```

## 02 · stateDiagram-v2

意图：一张图从起草、自审、校验到交付归档的生命周期，突出校验失败回退与尝试次数守卫。

```mermaid
stateDiagram-v2
    direction LR
    [*] --> Draft: "读取类型参考"

    state Review {
        [*] --> TypeOk: "类型匹配"
        TypeOk --> EncOk: "引号包裹"
        EncOk --> AutoOk: "autonumber"
        AutoOk --> [*]: "0 违规"
    }

    Draft --> Review: "起草完成"
    Review --> Fix: "违规大于 0"
    Fix --> Review: "修改后复审"

    Review --> Deliver: "全部通过"
    state Guard <<choice>>
    Deliver --> Guard
    Guard --> Delivered: "尝试小于 3"
    Guard --> Abandoned: "尝试等于 3"

    Delivered --> Archived: "归档 .mmd"
    Archived --> [*]: "完成"
    Abandoned --> [*]: "重新建模"

    note right of Review: "自审对照 self-check"
    note left of Guard: "3 连败后停止重试"
```

## 03 · classDiagram

意图：better-mermaid 包的模块结构：skill 本体、校验工具、lint 规则与参考文档之间的依赖与索引关系。

```mermaid
classDiagram
    namespace pi_better_mermaid {
        class Skill {
            <<skill>>
            +string name
            +string version
            +list validate(code, type)
        }
        class TypeTable {
            <<index>>
            +list types
            +string pick(intent)
        }
    }

    namespace validation {
        class MmdcCli {
            <<validator>>
            +string render(code)
            +list errors
        }
        class LintRules {
            <<lint>>
            +bool noSemicolon(text)
            +bool quotedLabels(text)
            +bool hasAutonumber(text)
        }
    }

    namespace references {
        class EncodedPrefs {
            <<doc>>
            +string quoting
            +string rectRule
        }
        class SelfCheck {
            <<doc>>
            +string checklist
        }
    }

    Skill --> TypeTable : "索引"
    Skill ..> MmdcCli : "调用"
    Skill ..> LintRules : "执行"
    MmdcCli ..> LintRules : "合并结果"
    Skill --> EncodedPrefs : "遵守"
    Skill --> SelfCheck : "自审"
    TypeTable "1" o-- "*" EncodedPrefs : "指向"
```

## 04 · erDiagram

意图：harness-eval 归档的数据形状：每张图经过多次校验、属于一种类型、受多条 lint 规则约束。

```mermaid
erDiagram
    DIAGRAM ||--o{ VALIDATION : "undergoes"
    DIAGRAM ||--o{ RETRY : "tolerates"
    DIAGRAM }o..o| TYPE : "belongs to"
    TYPE ||--o{ LINT_RULE : "constrained by"
    VALIDATION ||--o{ LINT_VIOLATION : "reports"

    DIAGRAM {
        string file_name PK
        string mermaid_code
        string intent "one-line modeling goal"
        string status "draft, passed, archived"
    }

    TYPE {
        string name PK
        string core_role
        string deep_dive "reference file"
    }

    LINT_RULE {
        string id PK
        string description
        bool mandatory
    }

    VALIDATION {
        int attempt PK
        string file_name FK
        string result "passed, failed"
        string svg_path
    }

    RETRY {
        int count PK
        string file_name FK
        string last_error
    }

    LINT_VIOLATION {
        int id PK
        int attempt FK
        string rule_id FK
        int line_no
    }
```

## 05 · flowchart

意图：mermaid 源码从输入、mmdc 语法校验（含失败重试循环）、lint 硬规则检查到 SVG 交付与归档的管线。

```mermaid
---
config:
  layout: elk
---
flowchart LR
    subgraph in ["输入"]
        direction LR
        Src@{ shape: doc, label: "mermaid 源码" }
        Strip@{ shape: lin-rect, label: "剥离围栏" }
    end

    subgraph check ["校验"]
        direction LR
        Mmd@{ shape: subroutine, label: "mmdc 渲染" }
        SynErr{"语法错误?"}
        Lint@{ shape: hexagon, label: "lint 硬规则" }
        LintOk{"0 违规?"}
        Fix@{ shape: bolt, label: "按错误修改" }
    end

    subgraph out ["交付"]
        direction LR
        Svg@{ shape: doc, label: "SVG 产物" }
        Arch@{ shape: das, label: "归档 .mmd" }
    end

    Src ==> Strip
    Strip ==> Mmd
    Mmd ==> SynErr
    SynErr ==>|"是"| Fix
    Fix -. "重试最多 3 次" .-> Mmd
    SynErr ==>|"否"| Lint
    Lint ==> LintOk
    LintOk ==>|"是"| Svg
    LintOk -->|"否"| Fix
    Svg ==> Arch
```

## 06 · requirementDiagram

意图：追溯技能的硬性编码需求（引号、无分号、autonumber、浅色 rect）如何被 lint 规则满足并被校验工具验证。

```mermaid
requirementDiagram

    designConstraint "req_quote" {
        id: "REQ-1"
        text: "所有文本字面量必须用双引号包裹"
        risk: high
        verifymethod: inspection
    }

    designConstraint "req_semicolon" {
        id: "REQ-2"
        text: "任何位置不得出现分号"
        risk: high
        verifymethod: inspection
    }

    functionalRequirement "req_autonumber" {
        id: "REQ-3"
        text: "时序图必须以 autonumber 开头"
        risk: medium
        verifymethod: inspection
    }

    designConstraint "req_rect" {
        id: "REQ-4"
        text: "rect 背景色每个通道必须大于 200"
        risk: medium
        verifymethod: inspection
    }

    functionalRequirement "req_type" {
        id: "REQ-5"
        text: "图类型必须与建模意图匹配"
        risk: low
        verifymethod: analysis
    }

    element "lint_rules" {
        type: "code"
        docref: "skill lint runner"
    }

    element "skill_docs" {
        type: "document"
        docref: "references/encoded-preferences.md"
    }

    element "mmdc_gate" {
        type: "tool"
        docref: "mermaid-cli 11.15.0"
    }

    "lint_rules" - satisfies -> "req_quote"
    "lint_rules" - satisfies -> "req_semicolon"
    "lint_rules" - satisfies -> "req_autonumber"
    "lint_rules" - satisfies -> "req_rect"
    "skill_docs" - refines -> "req_type"
    "mmdc_gate" - verifies -> "req_type"
    "req_quote" - derives -> "req_type"
```

## 07 · gitGraph

意图：pi-better-mermaid 包的开发历史：三条特性分支经 cherry-pick 与 merge 汇入 main 并打版发布。

```mermaid
gitGraph
    commit id: "init" tag: "v0.1.0"
    branch skill
    checkout skill
    commit id: "types"
    commit id: "prefs"
    checkout main
    commit id: "tui"
    merge skill tag: "v0.2.0"
    branch validator
    checkout validator
    commit id: "mmdc"
    commit id: "lint"
    checkout main
    commit id: "evals"
    cherry-pick id: "lint"
    merge validator tag: "v0.3.0"
    checkout skill
    commit id: "selfcheck"
    checkout main
    commit id: "docs" type: HIGHLIGHT
    merge skill tag: "v0.4.0"
```

## 08 · timeline

意图：mermaid 渲染能力演进：从基础布局到 v11.15 的新图类型与语法能力，再到 pi 的 TUI 渲染与校验门禁集成。

```mermaid
timeline
    title Mermaid 渲染能力演进
    section 基础能力
        10.x : 新形状语法
        11.0 : block 图发布
        11.3 : 扩展形状体系
    section v11.15 新能力
        11.15 : eventmodeling 图
              : classDiagram 命名空间
              : sankey labelStyle 与 nodeColors
              : 时序图 autonumber 自定义步长
    section pi 集成
        现在 : TUI 直接渲染 mermaid 图块
              : better-mermaid 校验门禁
              : harness-eval 归档
```

## 09 · gantt

意图：带依赖与里程碑的检测排期：准备 → 两批渲染测试 → 交付归档，突出关键路径。

```mermaid
gantt
    title pi-better-mermaid 能力检测计划
    dateFormat YYYY-MM-DD
    excludes weekends
    section 准备
        读取 skill 与类型参考 :done, p1, 2025-08-12, 1d
        搭建 mmdc 校验环境 :done, p2, 2025-08-12, 1d
    section 渲染测试
        常用类型渲染 :active, t1, after p2, 2d
        冷门类型渲染 :t2, after t1, 2d
        失败重试与修复 :crit, t3, after t2, 1d
    section 交付
        全部归档 :milestone, m1, after t3, 0d
        TUI 渲染验收 :crit, t4, after t3, 1d
        生成索引文档 :t5, after t4, 1d
```

## 10 · mindmap

意图：技能知识结构：建模、表现力、编码、校验四大支柱及其子要点。

```mermaid
mindmap
    root((better-mermaid))
        建模
            意图一句话
            类型表选择
            更具体的类型优先
        表现力
            序列图 alt loop par
            状态图复合态
            类图命名空间
            eventmodeling 泳道
        编码
            "所有字面量加引号"
            "禁止分号"
            "autonumber 必开"
            "rect 浅色"
        校验
            mmdc 渲染
            lint 硬规则
            3 次重试上限
        交付
            TUI 渲染图块
            harness-eval 归档
```

## 11 · C4Context

意图：pi 的 mermaid 渲染生态：用户与 pi TUI、skill、mmdc 校验门禁、归档目录之间的系统边界与交互。

```mermaid
C4Context
    title pi mermaid 渲染与校验生态
    Person(user, "用户", "在 pi TUI 中请求画图")
    Enterprise_Boundary(b0, "pi agent 工具链") {
        System(tui, "pi TUI", "直接渲染 mermaid 图块")
        System(skill, "better-mermaid skill", "起草图并按硬规则编码")
        SystemDb(mmdc, "mmdc CLI", "mermaid-cli 11.15.0")
        SystemQueue(gate, "校验门禁", "lint 硬规则 + 3 次重试上限")
    }
    System_Ext(archive, "harness-eval 目录", "归档 .mmd 源文件与 SVG")

    Rel(user, tui, "请求画图", "对话")
    Rel(tui, skill, "调用", "skill 工具")
    Rel(skill, mmdc, "提交渲染", "mmdc")
    Rel(mmdc, gate, "结果判定", "结构化错误")
    Rel(gate, archive, "通过后归档", "写入")
    BiRel(tui, user, "渲染图块")

    UpdateRelStyle(user, tui, $offsetY="-30")
    UpdateRelStyle(skill, mmdc, $offsetY="-10")
```

## 12 · block

意图：校验产物的静态排布：源码经复合校验块（渲染+lint）流到 SVG，失败走重试路径，最终归档。

```mermaid
block
columns 3
    Src[("mermaid 源码")]
    block:check
        columns 1
        Mmd{"mmdc 渲染"}
        Lint{"lint 硬规则"}
    end
    Svg[("SVG 产物")]
    blockArrowId1<["校验"]>(down)
    space
    blockArrowId2<["交付"]>(down)
    Retry["重试最多 3 次"]
    space
    Arch[("归档 .mmd")]

    check --> Svg
    Retry -.-> Mmd
    Svg ==> Arch

    style Src fill:#dde
    style Arch fill:#dfd
```

## 13 · journey

意图：以用户情感评分呈现请求一张 mermaid 图的全旅程：请求阶段低分焦虑、校验失败触底、渲染成功与归档高分收尾。

```mermaid
journey
    title 请求一张 mermaid 图的体验
    section 请求阶段
        提出需求: 5: 用户
        等待类型选择: 2: 用户
        观察起草过程: 3: 用户, Agent
    section 校验阶段
        提交渲染: 3: Agent
        发现语法错误: 1: 用户, Agent
        修复并重试: 3: Agent
        全部通过: 5: 用户, Agent
    section 交付阶段
        看到渲染图: 5: 用户
        归档完成: 4: Agent, 用户
```

## 14 · quadrantChart

意图：按建模匹配度与实现成本评估各类图类型：左上首选（高匹配低成本），右下为高成本低匹配应避免。

```mermaid
quadrantChart
    title 图类型评估: 匹配度 vs 成本
    x-axis "低成本" --> "高成本"
    y-axis "低匹配度" --> "高匹配度"
    quadrant-1 费劲但值得
    quadrant-2 首选
    quadrant-3 凑合可用
    quadrant-4 尽量别碰
    sequence: [0.25, 0.90]
    state: [0.30, 0.85]
    class: [0.35, 0.80]
    er: [0.40, 0.78]
    flowchart: [0.20, 0.60]
    eventmodeling: [0.55, 0.75]
    requirement: [0.50, 0.72]
    gitGraph: [0.30, 0.55]
    gantt: [0.55, 0.50]
    mindmap: [0.18, 0.50]
    journey: [0.40, 0.42]
    xychart: [0.50, 0.45]
    sankey: [0.62, 0.52]
    block: [0.60, 0.62]
    c4: [0.72, 0.60]
    quadrant: [0.48, 0.38]
```

## 15 · sankey-beta

意图：测试请求按类型分发的流量，以及各类别一次通过与重试修复后的最终归档汇合，保持总量守恒。

```mermaid
sankey
Requests,Sequence,5
Requests,State,4
Requests,Class,3
Requests,ER,3
Requests,Flowchart,5
Requests,Others,10
Sequence,PassFirst,4
Sequence,Retry,1
State,PassFirst,3
State,Retry,1
Class,PassFirst,2
Class,Retry,1
ER,PassFirst,3
Flowchart,PassFirst,3
Flowchart,Retry,2
Others,PassFirst,7
Others,Retry,3
PassFirst,Archived,22
Retry,Archived,8
```

## 16 · xychart-beta

意图：对比各图类型的校验尝试次数，展示哪些类型一次通过、哪些需要重试。

```mermaid
xychart-beta
    title "各图类型校验尝试次数"
    x-axis ["sequence", "state", "class", "er", "flowchart", "requirement", "gitGraph", "timeline", "gantt", "mindmap", "c4", "block", "journey", "quadrant", "sankey", "xychart", "event"]
    y-axis "尝试次数" 0 --> 3
    bar [1, 1, 2, 1, 2, 1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1]
    line [1, 1, 2, 1, 2, 1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1]
```

## 实战中发现的坑（已在 skill 文档之外验证）

1. **`-- "label" ==>` 组合解析失败**（flowchart）：带引号标签的粗箭头必须写成 `==>|"label"|`；skill 的 flowchart.md 未覆盖此组合。
2. **带引号的 namespace 名解析失败**（classDiagram，11.15.0 实测）：`namespace "pi-better-mermaid" {` 报 Parse error，文档示例写法不可用；改用下划线标识符 `namespace pi_better_mermaid {`。
3. **sankey CSV 节点名不支持中文**：非 ASCII 节点名直接 Lexical error；节点标签须用 ASCII。
4. **block 图不支持 `{["..."]}` 菱形内嵌**：用 `{"..."}` 或 `["..."]` 单层形状。
5. **better-mermaid 工具 frontmatter 误判**：传 `type` 参数时，frontmatter（`---`）开头会被判为图头不匹配；不传 `type`（或去掉 frontmatter）即可。
6. **并发调用竞态**：首个 better-mermaid 调用会按需初始化 mmdc，并发调用可能误报"mmdc 不可用"；串行重发即可。
7. **timeline/gantt/xyChart 等 DSL 型图**：`""` 全包裹规则仅适用于标签类字面量，数字、坐标、CSV 值、时长按 DSL 原生书写。
8. **eventmodeling 已弃用（2025-08-13）**：mermaid@11.15.0 对其渲染输出错误页（SVG 内含 "Syntax error in text"）。已从能力清单移除（16/16），skill 文档（SKILL.md / self-check / encoded-preferences / types/eventmodeling.md）同步标注弃用，evals 移除 cqrs-eventmodeling 用例；CQRS 笔记改用 `sequenceDiagram` + `box`/`alt`。
9. **门禁假阳性（已修复）**：旧版 better-mermaid 对 eventmodeling 报 pass——mmdc 退出码 0 且有 SVG 产物即判通过，但 SVG 其实是错误页。工具现已增加 SVG 内容检查（含 `error-text` / `Syntax error in text` 即判失败）。

## 复现

```bash
for f in *.mmd; do mmdc -i "$f" -o "${f%.mmd}.svg"; done
```
