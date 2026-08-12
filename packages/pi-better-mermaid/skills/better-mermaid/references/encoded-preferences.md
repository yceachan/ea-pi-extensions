# Encoded Preferences — strict local rules for Mermaid output

This document is the *contract* between writing-mermaid and the surrounding notebook (VitePress + Obsidian). Every rule here was added because something concretely broke before. Treat them as preconditions, not "best practices to consider."

Engine baseline: **mermaid 11.15.0** (latest at time of writing, freshly upgraded). Any feature gated as `v11.x+` in the upstream docs is now safe.

---

## 1. Wrap every text literal in `""`

Applies to **every** label / message / note / alias the renderer parses as text.

```
// nodes
A["GPIO 库"]   not   A[GPIO 库]
B["start()"]   not   B[start()]
C["plain ascii"]  -- yes, even here.

// flowchart edge labels
A -- "调用" --> B
A -->|"返回 ok"| B
                       not   A -- 调用 --> B

// sequenceDiagram messages
ISR ->> Driver: "handle_irq()"
                       not   ISR ->> Driver: handle_irq()

// notes
note over Driver,Wq: "scheduled via queue_work()"

// participant alias
participant Rs as "tspi-greet-rs (Rust)"
```

**Why uniform-quote everything, including ASCII**

- Mermaid's parser uses heuristics to decide when a label "needs" quoting. Edge cases — `()` `:` `/` `,` mixed with CJK, line breaks inside labels — silently corrupt the parse on some layouts. The docs say quoting is *optional*; empirically it is the only stable posture.
- "Quote only when special chars appear" forces you to re-scan a label every time it changes. Quote-everything makes the rule *mechanical* — no judgment calls, no regressions when someone adds a `(` later.
- Past failures: function signatures `void foo()`, paths `/sys/class/gpio`, Chinese-English mixed labels — each broke at least once before the uniform rule was adopted.

---

## 2. Never use `;`

- **Not** as a statement separator at the top level (`A-->B; C-->D` — never).
- **Not** inside labels — `"void foo();"` → `"void foo()"` or split the line with `<br/>`.
- **Not** inside note text. If the prose calls for a semicolon, rephrase or use `<br/>`.

**Why**

Some mermaid layouts treat `;` as a statement separator even inside a quoted-looking context, and have silently truncated diagrams at the first `;`. Multi-statement-per-line style is not worth the risk; one statement per line is also more diff-friendly.

---

## 3. `sequenceDiagram` MUST start with `autonumber`

```
sequenceDiagram
    autonumber
    participant App
    participant Drv as "char-dev driver"
    ...
```

**Why**

Numbered messages give the surrounding prose anchors ("step 3 returns -EAGAIN to userspace…"). Without `autonumber`, references become "the third arrow from the top," which rots the moment you insert a step.

If you genuinely want to reset numbering mid-diagram (rare), v11.15.0 supports `autonumber <start> <increment>` (see `mermaid-docs/syntax/sequenceDiagram.md` → *Start and Increment values*).

---

## 4. `rect rgb(R,G,B)` — every channel > 200

Background-highlight regions in sequence (and other) diagrams must use **light** colors so black text remains legible.

```
rect rgb(220, 235, 255)       // good — pale blue
    Alice ->> Bob: "init"
    Bob -->> Alice: "ack"
end

rect rgb(120, 60, 60)         // BAD — dark, text becomes unreadable
    ...
end
```

Suggested palette (all channels > 200):

| Intent              | rgb                  |
| ------------------- | -------------------- |
| Happy path          | `rgb(220, 245, 220)` (pale green)  |
| Error / rollback    | `rgb(250, 220, 220)` (pale red)    |
| Kernel-space region | `rgb(220, 230, 250)` (pale blue)   |
| Userspace region    | `rgb(250, 245, 215)` (pale yellow) |
| Neutral grouping    | `rgb(235, 235, 235)` (pale grey)   |

**Why**

The notebook is rendered on a light theme; saturated / dark background blocks make the *foreground* (the messages and participants) disappear. The > 200 rule is a cheap invariant that guarantees readable contrast without per-diagram color-picking.

---

## 5. Frontmatter `config:` block for non-default layouts

When a flowchart has > ~12 nodes or you want named directions/themes, prefer the YAML frontmatter form over inline `%%{init}%%` directives:

```
---
config:
  layout: elk
  theme: neutral
---
flowchart LR
    ...
```

ELK (`layout: elk`) routes large flowcharts dramatically better than the default Dagre layout — orthogonal edges, fewer overlaps. For ≤ ~8 nodes default Dagre is fine.

For class / sequence / state, the default layout is usually fine; reach for `themeVariables` only when you have a concrete visual problem.

---

## 6. Always pick the most specific diagram type

This is not formatting, but it belongs in the contract: **do not use `flowchart` / `graph` for things another type models natively**. See the type table in [SKILL.md](../SKILL.md) — every fallback to `graph TD` for something that is actually a sequence / state / class / ER is a missed modeling opportunity *and* makes the diagram harder to read.

---

## 7. One diagram = one intent

If you find yourself adding a *second* logical concern to a diagram (e.g., timing arrows on a class diagram, schema attributes on a flowchart), split it. Two simple diagrams almost always beat one cluttered one — and they can sit in adjacent fences in the same note.

---

## Anti-patterns — auto-reject before emitting

| Symptom                                                                       | Fix                                                                                  |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `A[label text]` without quotes                                                | `A["label text"]`                                                                    |
| `A -- label --> B`                                                            | `A -- "label" --> B`                                                                 |
| `note over A,B: text`                                                         | `note over A,B: "text"`                                                              |
| `sequenceDiagram` without `autonumber` on line 2                              | Add `autonumber`.                                                                    |
| `rect rgb(80, 100, 200)` (dark channel)                                       | Lighten so every channel > 200.                                                      |
| Any `;` anywhere                                                              | Newline or `<br/>`.                                                                  |
| `flowchart` for an actor-to-actor message sequence                            | `sequenceDiagram`.                                                                   |
| `flowchart` modelling a state machine ("idle → running → done")               | `stateDiagram-v2`.                                                                   |
| Single node holds > 4 distinct responsibilities                               | Split or move to `classDiagram`.                                                  |
| Mixed-abstraction-level top-level boxes (one says "TCP", another says "ack")  | Pull lower-abstraction parts into a subgraph or a separate diagram.                  |
