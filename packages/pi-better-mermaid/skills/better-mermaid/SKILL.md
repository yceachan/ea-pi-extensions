---
name: better-mermaid
description: Author high-quality Mermaid diagrams (v11.15.0) for notes, design docs, RFCs, and code commentary. Use whenever the user asks for a "图 / 流程图 / 时序图 / 状态机 / 类图 / 架构图 / ER 图 / 需求图 / event modeling / mindmap / gantt / timeline" or hand-writes a ```mermaid``` block — pick the most expressive diagram type for the modeling intent, exploit advanced syntax (alt/opt/loop/par, composite states, namespaces, swimlanes), apply the local strict-encoding rules ("" wrapping, no ;, autonumber, rect rgb>200), and self-audit before emitting. Do not fall back to a plain `graph` when a more specific diagram models the problem better.
---


# better-mermaid

You are writing Mermaid for a notebook that renders with **mermaid@11.15.0** under VitePress / Obsidian. The author has been bitten by render failures and shallow `graph TD` overuse, so this skill exists to make every diagram **type-appropriate, depth-modeled, and reliably renderable**.

The skill enforces three orthogonal concerns — keep them separate in your head:

1. **Modeling** — pick the right diagram *type* for the intent. A sequence diagram is not a substitute for a state machine.
2. **Expressiveness** — use the *advanced* syntax of the chosen type (alt/opt/loop/par, composite states, namespaces, swimlanes, rect-bg, notes). A `sequenceDiagram` with only `A->>B: x` is wasted potential.
3. **Encoding** — obey the strict local rules so it actually renders.

Each concern has its own reference. Load only what you need.

## Workflow

1. **Restate the modeling intent in one sentence** (out loud, in your reply). What invariant / sequence / structure / state-transition is the diagram supposed to make legible? This single step prevents 90 % of "wrong type" failures.
2. **Pick the type** from the table below. If multiple fit, pick the more constrained one (state machine > flowchart with diamonds; sequence > flowchart with arrows).
3. **Read the matching `references/types/<type>.md`** before writing — even if you "know" the syntax. The advanced features you are about to skip are exactly what separates a usable diagram from a doodle.
4. **Draft.** Apply [`references/encoded-preferences.md`](references/encoded-preferences.md) rules from the first character — don't write loose then retrofit `""`.
5. **Self-audit** against [`references/self-check.md`](references/self-check.md). Read each item out loud against your draft. If anything fails, fix before emitting.
6. **Emit** the ```mermaid``` block. No prose-only summary of what the diagram "would show" — either the diagram is right, or you redraw.

## Type metadata table — progressive disclosure

This is the index. Read the row, pick the type, then open the referenced file. **Do not load all of them.**

| Type                  | Core role                                           | When to reach for it                                         | Deep dive                                               | Upstream doc                                     |
| --------------------- | --------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------ |
| `sequenceDiagram`     | Time-ordered message exchange between actors        | API call chain, IRQ → softirq → wq path, RPC, login flow, kernel ↔ user round-trip | [types/sequence.md](references/types/sequence.md)       | mermaid-docs/syntax/sequenceDiagram.md           |
| `stateDiagram-v2`     | Finite-state behavior + transitions + entry/exit    | Driver lifecycle, TCP states, power management, framework state machine, parser modes | [types/state.md](references/types/state.md)             | mermaid-docs/syntax/stateDiagram.md              |
| `classDiagram`        | Static structure: types, fields, methods, relations | Struct/ops layout, OO hierarchy, kernel subsystem types, ownership / aggregation | [types/class.md](references/types/class.md)             | mermaid-docs/syntax/classDiagram.md              |
| `erDiagram`           | Data schema: entities, keys, cardinality            | DB schema, on-disk struct layout w/ FK-like links, config-tree relations | [types/er.md](references/types/er.md)                   | mermaid-docs/syntax/entityRelationshipDiagram.md |
| `flowchart`           | Decision / dispatch / pipeline with branching       | Build pipeline, decision tree, generic control flow that is **not** a single actor's state | [types/flowchart.md](references/types/flowchart.md)     | mermaid-docs/syntax/flowchart.md                 |
| `requirementDiagram`  | Requirement ↔ design-element traceability           | SRS-style write-ups, "feature X satisfies req Y, verified by Z" | [types/requirement.md](references/types/requirement.md) | mermaid-docs/syntax/requirementDiagram.md        |
| `gitGraph`            | Branch / merge / rebase history                     | Release workflow, feature-branch story, illustrating git internals | mermaid-docs/syntax/gitgraph.md                         | —                                                |
| `timeline`            | Chronological events on a single axis               | Project milestones, release history, "what happened when"    | mermaid-docs/syntax/timeline.md                         | —                                                |
| `gantt`               | Scheduled tasks with dependencies                   | Plan with durations + critical path                          | mermaid-docs/syntax/gantt.md                            | —                                                |
| `mindmap`             | Hierarchical concept expansion                      | Brainstorm / topic decomposition / onboarding map            | mermaid-docs/syntax/mindmap.md                          | —                                                |
| `C4Context` / `block` | High-level system / deployment layout               | "Boxes-and-arrows" architecture diagram where flowchart would be too flat | mermaid-docs/syntax/c4.md, block.md                     | —                                                |
| `journey`             | UX flow with per-step satisfaction score            | User-journey notes, onboarding pain points                   | mermaid-docs/syntax/userJourney.md                      | —                                                |
| `quadrantChart`       | 2x2 categorization                                  | "Important vs Urgent", trade-off framing                     | mermaid-docs/syntax/quadrantChart.md                    | —                                                |
| `sankey-beta`         | Flow magnitude between stages                       | Traffic split, energy / memory budget, conversion funnels    | mermaid-docs/syntax/sankey.md                           | —                                                |
| `xychart-beta`        | Inline line / bar chart                             | Benchmark numbers, latency-over-time                         | mermaid-docs/syntax/xyChart.md                          | —                                                |

The rightmost columns without a "Deep dive" entry are **rarely the right tool** in this repo — fall back to the upstream doc only when one of them is genuinely the best fit. The seven types with deep-dive files are the ones the author writes frequently.

## Hard preferences — non-negotiable

These are encoded in [`references/encoded-preferences.md`](references/encoded-preferences.md) with full reasoning. Summary:

- **Engine: 11.15.0** (recently updated). Syntax gated as `v11.x+` is now safe to use — namespaces in classDiagram, eventmodeling, central connections in sequenceDiagram, expanded flowchart shapes, sequenceNumber start/increment, etc.
- **Wrap every text literal in `""`** — node labels, edge labels, sequence messages, notes, participant aliases. *Every one*, even pure ASCII. Reason: mixed-CJK / parens / slashes have repeatedly broken rendering; uniform quoting is the only stable posture.
- **Never use `;`** — neither as a statement separator nor inside labels. Replace with newlines or `<br/>`. Reason: layouts have historically truncated on `;`.
- **`sequenceDiagram` MUST start with `autonumber`** — numbered messages are how the surrounding prose references the diagram.
- **`rect rgb(R,G,B)` background blocks** in sequence diagrams — **every channel > 200**. Black text on a dark background is unreadable.
- **Frontmatter `config:` block** when you need a non-default layout — for flowcharts of ≥ 12 nodes prefer `elk` (`flowchart-elk`) for cleaner routing.

If you find yourself wanting to break one of these rules, you are almost certainly modeling the wrong thing — go back to step 1.

## Self-audit (before emitting)

Run through [`references/self-check.md`](references/self-check.md) — abridged here:

- **Type appropriateness** — does the chosen type's *primitives* match the things you're trying to show? If you used `graph` and your labels say "send / receive / await", you wanted `sequenceDiagram`.
- **Granularity** — is any single node a "god node" (holds > 4 distinct responsibilities)? Split it, or move to a different diagram. Top-level boxes should be at one consistent abstraction layer.
- **Advanced-syntax usage** — does the diagram exercise at least one *non-trivial* feature of its type (alt/opt/loop/par/notes for sequence; composite/concurrency for state; namespace/cardinality for class)? If not, you are drawing a stick figure — either there's no value in the diagram, or you skipped expressive primitives.
- **Encoding** — every text literal `""`-wrapped? Zero `;`? autonumber present for sequence? rect rgb channels all > 200?
- **Rendering sanity** — would a reader who hasn't read the surrounding prose still understand what this diagram is *about* from the title comment and node names alone?

## Subagent dispatch — when the syntax research dwarfs the diagram

This skill keeps the main SKILL.md and the loaded reference small on purpose. Most diagrams need one type file (~150 lines) and the encoded preferences (~80 lines) — well under any context-pressure threshold.

**Dispatch to a subagent only when**:

- The user is asking for *multiple* unfamiliar diagram types in one task (e.g., "draw both a state diagram for the driver and a sankey for the IO budget"), AND
- You'd otherwise have to load 3+ syntax references AND the upstream `mermaid-docs/syntax/*.md` files into your own context.

In that case, hand the *modeling intent in prose* plus the relevant `references/types/*.md` path to an `Explore` or `general-purpose` subagent and ask it to **return only the finished ```mermaid``` block**. The main agent stays focused on the surrounding note / explanation that motivates the diagram — that is the actual knowledge product.

For single-diagram tasks, **do not dispatch** — the round-trip is more expensive than reading one reference file inline.

## File map

```
skills/better-mermaid/ （本包捆绑）
├── SKILL.md                         (this file — index + workflow)
└── references/
    ├── encoded-preferences.md       (the strict rules + why)
    ├── self-check.md                (pre-emit checklist)
    ├── types/
    │   ├── sequence.md
    │   ├── flowchart.md
    │   ├── class.md
    │   ├── state.md
    │   ├── er.md
    │   ├── requirement.md
    │   └── eventmodeling.md
    └── mermaid-docs/                (upstream v11.15 docs, sparse-clone)
        ├── syntax/*.md              (authoritative for any type)
        ├── config/                  (theming, layouts, mermaidCLI)
        └── intro/, ...
```
