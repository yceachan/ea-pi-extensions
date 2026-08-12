# Self-Check — pre-emit checklist

Run this before pasting any ```mermaid``` block into the output. It is short on purpose. **Read each item against the actual draft**, not against your memory of what you intended.

The checklist is grouped into four phases. Failing any item → fix, don't ship.

---

## Phase A — Modeling fit

**A1. Did I state the modeling intent in one sentence?**
If the answer to "what is this diagram supposed to make legible?" is more than one sentence, the diagram is doing two jobs. Split it.

**A2. Does the diagram type's primitives match what I'm showing?**

| If the prose talks about…                              | The type should be…             |
| ------------------------------------------------------ | ------------------------------- |
| "call / return / send / receive / await / response"    | `sequenceDiagram`               |
| "state / transition / enters / exits / on event"       | `stateDiagram-v2`               |
| "has-a / inherits / implements / type / field / method"| `classDiagram`                  |
| "entity / key / relationship / cardinality / FK"       | `erDiagram`                     |
| "command / event / read-model / swimlane / timeline"   | ~~`eventmodeling`~~ DEPRECATED — use `sequenceDiagram` (with `box` / `alt`) |
| "requirement / satisfies / verifies / risk"            | `requirementDiagram`            |
| "branch / merge / rebase / tag"                        | `gitGraph`                      |
| "anything else — decision tree, pipeline, dispatch"    | `flowchart`                     |

A `flowchart` masquerading as one of the rows above is the most common failure. Re-pick the type before fixing anything else.

**A3. Is there exactly one abstraction level at the top?**
If the top-level boxes contain *both* "TCP" and "ack" (subsystem vs. message), or *both* "Driver" and "open() ioctl close()" (component vs. operation), you have mixed levels. Either pull the lower level into a subgraph / composite state, or split into two diagrams.

---

## Phase B — Depth / expressiveness

**B1. Does the diagram use ≥ 1 advanced primitive of its type?**

Each type has primitives that distinguish *modeling* from *doodling*. If the draft uses none of them, either the diagram has no information density (delete it) or you skipped expressive syntax (add it).

| Type                | "I used at least one of…" — pick one or more                                  |
| ------------------- | ----------------------------------------------------------------------------- |
| `sequenceDiagram`   | `alt/else`, `opt`, `loop`, `par`, `critical`, `rect rgb`, `note`, activations |
| `stateDiagram-v2`   | composite state, `[*]` start/end, `--` concurrency, `<<choice>>`, `<<fork>>`, notes |
| `classDiagram`      | `<<interface>>` / `<<abstract>>`, namespace, cardinality `"1" --> "*"`, lollipop, notes |
| `erDiagram`         | identifying vs non-identifying (`||--||` vs `||..o{`), attribute keys (PK/FK), aliases |
| `flowchart`         | subgraph, > 1 node shape, edge labels, direction nesting (`subgraph X direction TB`) |
| `requirementDiagram`| typed requirements (`functionalRequirement` / `performanceRequirement`), `risk`, `verifymethod`, `satisfies` / `verifies` links |

A `sequenceDiagram` of pure `A->>B: x` lines is the canonical doodle. At minimum add `note` and one `alt` / `loop` block to make it earn its place.

**B2. Is any single node a "god node"?**
A box with > 4 distinct responsibilities, or a class with > 8 members, drowns the diagram. Options: split the node, drop to a separate `classDiagram` for the internals, or use composite states to hide detail.

**B3. Is the diagram size sensible?**
Sequence: ≤ ~15 messages per diagram before it stops being scannable. Flowchart: ≤ ~20 nodes (and even then, ELK layout). Class: ≤ ~8 classes. If you're over budget, split by concern.

---

## Phase C — Encoding (mechanical, fast)

Run these as a grep-style pass. They take ten seconds.

- **C1.** Every node / message / note / alias label is wrapped in `""`. *Every* one, including ASCII.
- **C2.** Zero `;` anywhere in the source.
- **C3.** For `sequenceDiagram`: second line is `autonumber`.
- **C4.** Every `rect rgb(R,G,B)`: R > 200 AND G > 200 AND B > 200.
- **C5.** No `<br>` (HTML4); use `<br/>` (mermaid's accepted form).
- **C6.** For flowcharts ≥ 12 nodes: frontmatter sets `layout: elk`.

If any of C1–C6 fail, fix mechanically — no judgment needed.

---

## Phase D — Reader's test

**D1.** A reader who scrolls past the surrounding prose and lands directly on the diagram — can they tell what the diagram is *about* from titles, participant names, and node labels alone? If not, the labels are too terse.

**D2.** If you removed every prose sentence that referenced the diagram by step number, would the diagram still hold its claim? If the diagram only makes sense because the prose explains it, you've drawn an illustration, not a model. The diagram should carry weight.

---

## When the self-check finds something

- **Cheap fixes (C1–C6, B3, D1)** — just fix and re-check.
- **A2 fails (wrong type)** — start over from the type table in SKILL.md. Don't patch.
- **B1 fails (no advanced syntax)** — open the matching `references/types/<type>.md` and add the missing primitive *only if it carries information*. Don't add `loop` or `alt` for show.
- **A3 / B2 fails (mixed abstraction or god node)** — split into two diagrams. Two clean diagrams in adjacent fences beat one cluttered one.

---

## Why this checklist exists

The author has, on a per-diagram basis, repeatedly seen these failure modes:

1. **`graph TD` everywhere** — even when sequence / state / class would have been correct and far more readable.
2. **Stick-figure sequence diagrams** — only `A->>B: x` arrows, no alt/loop/note, so the diagram conveys nothing the prose didn't already.
3. **Render failures from missing `""` or stray `;`** — wasted iterations.
4. **God nodes** — one box that says "kernel handles everything," which is uninformative.

Each phase of the checklist targets one of those failure modes directly. The cost of running it is < 30 seconds; the cost of shipping a broken diagram is much higher.
