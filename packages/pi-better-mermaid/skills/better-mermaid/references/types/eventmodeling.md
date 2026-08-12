# eventmodeling — deep dive (v11.15.0+)

> ⚠ **DEPRECATED — 2025-08-13**: mermaid@11.15.0 renders this diagram as an
> error page (SVG contains "Syntax error in text"); mmdc exits 0 so the old
> gate passed it — that false-positive is now fixed. Do **not** deliver
> `eventmodeling` diagrams; model CQRS / event flows with `sequenceDiagram`
> (`box` groups + `alt` / `loop` blocks). This file is kept for reference only.

**Upstream:** `references/mermaid-docs/syntax/eventmodeling.md`

**Core role.** Event-storming / event-modeling style timeline: a horizontal sequence of *time frames* organized into swimlanes — UI, Command, Event, View/ReadModel. Makes information flow over time legible.

**Reach for it when** notes are about CQRS, event sourcing, "user clicks X → command Y → event Z → read model W," or any user-journey-through-state walkthrough that benefits from swimlanes.

**Do not reach for it when** the flow has no event/command vocabulary — `sequenceDiagram` is the generic alternative.

> Requires mermaid 11.15+. The author has just upgraded to 11.15.0, so this type is now available.

---

## Skeleton

```mermaid
eventmodeling

tf 01 ui  "CartUI"
tf 02 cmd "AddItem" { "sku": "string", "qty": "int" }
tf 03 evt "ItemAdded" { "sku": "string", "qty": "int", "at": "timestamp" }
tf 04 view "CartView" { "items": "list" }
```

Two syntaxes, interchangeable:

- **Compact** — `tf <id> <type> <name>`
- **Relaxed** — `timeframe <id> <type> <name>`

Compact reads better for dense diagrams; relaxed for one-off illustrations.

Time-frame IDs are unique and any number; ordering on the timeline is determined by ID. Use 2 digits (`01`, `02`, …) for small diagrams, 3+ for room to insert later.

---

## Time-frame types (swimlanes)

| Compact | Relaxed     | Swimlane meaning                       |
| ------- | ----------- | -------------------------------------- |
| `ui`    | `ui`        | UI / user touch-point                  |
| `cmd`   | `command`   | Command (intent to change state)       |
| `evt`   | `event`     | Event (immutable fact, past tense)     |
| `view`  | `readmodel` | Read model / view (derived state)      |
| `proc`  | `processor` | Automation / saga / reactor            |

Order on the page is fixed by swimlane: UI on top, then Commands, Events, Views. Each `tf` lands in its lane.

---

## Inline data

```
tf 02 cmd "AddItem" { "sku": "string", "qty": "int" }
tf 03 evt "ItemAdded" { "sku": "string", "qty": "int", "at": "timestamp" }
```

Curly-brace data block on the same line. Keys quoted, types quoted — keep the encoded-preferences `""` discipline.

---

## Implicit relations

By default, consecutive time frames are linked left-to-right. The DSL is designed so you express *what happened*, not *which arrow goes where*. Relations are inferred from order + swimlane.

For explicit cross-frame links (out of order, or many-to-one), see upstream `eventmodeling.md` → relation syntax — rare in practice for note-style usage.

---

## Patterns

**State View** (read-only flow): `ui → view` — user looks at derived state.

**State Change** (write flow): `ui → cmd → evt → view` — user issues command, event records the change, view updates.

**Translation** (boundary crossing): `evt → cmd` via a processor — one bounded context reacts to another's event.

**Automation** (reactor / saga): `evt → proc → cmd → evt …` — no UI step, just events triggering further commands.

---

## Don't

- Don't use `eventmodeling` for non-event-style flows — it forces a vocabulary that won't fit. Use `sequenceDiagram`.
- Don't crowd > ~10 time frames in one diagram — split by use case (each business scenario = one diagram).
- Don't omit inline data on commands and events when the data shape is the interesting part — that's half the point of event modeling.
- Don't forget — this is **v11.15.0+** only. Older renderers will show a syntax error.
