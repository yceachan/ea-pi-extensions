---
name: code-review
description: Use when reviewing a pull request — orients the reviewer to the codebase's standards (AGENTS.md conventions, defensive patterns, decision records, quality gates) and the review-specific checks that code alone can't show
---

# Reviewing a PR

**This skill is guidance, not a complete checklist.** Verify and fetch the PR's live base and exact head, then establish the committed change scope against that base — the repository's change-scope report where one exists, otherwise a diff against the verified base — before reading the diff and enough surrounding code to understand the design. The report identifies paths and dirty layers but does not replace semantic review. Re-establish the base and rerun it after a retarget or merge. Prioritize correctness, lifecycle, security, and broken required behavior over style; a short review with one substantiated blocker is better than a list of nits.

## Sources of truth

- The repository's root and package-level `AGENTS.md`: standing repository and package authoring rules.
- The repository's defensive-patterns documentation, where present: subprocess, callback, async-state, and disposal bug classes.
- The documentation standard: documentation placement and prose discipline.
- [prose-standard](../prose-standard/SKILL.md): required coverage and editorial judgment for comments, docs, prompts, and visible strings.
- The testing documentation and quality-gate decision records: required test tiers and gates.
- Decision records (Agent Notes): design rationale. Treat disagreement with a record as a design discussion, not an automatic veto.
- For bilingual changes, read the repository's translation rules and terminology table; extended translation workflows are outside automatic review and run only on explicit user invocation.

## Blocking requirements

1. **New prose receives semantic review.** Use [prose-standard](../prose-standard/SKILL.md) to critically review every added or changed Markdown passage, JSDoc, comment, prompt, description, diagnostic, and visible string. Verify required coverage, accuracy, placement, and editorial quality against the owning code or behavior; automated checks do not establish those properties.
2. **Docs match the code.** Config, defaults, errors, wire fields, events, and public behavior update the package README and JSDoc in the same diff. Comments state non-obvious contracts; flag implementation narration, test walkthroughs, review history, and duplicated rationale for deletion or a link to their one home.
3. **Core type docs match.** Changes to core (spine or seam) type vocabulary update the appropriate subsystem or architecture page and any type-catalog entry. Internal types need no catalog entry.
4. **Registrations clean up.** Verify each new registry contribution passes the disposal tests required by the package rules.
5. **Invariant checks are semantic.** For every touched invariant-style check, require an owner event-stream or mutable-data relationship at the point where that package can observe it; service or method presence, plugin metadata or effects, and fixed pure examples belong in type, load, or unit tests. Accept an empty installer when its package-specific reason establishes that no plausible runtime relationship exists; do not demand an invented check merely to eliminate emptiness.
6. **Required evidence exists.** Verify the author ran the relevant local checks for the diff and that CI covers the exhaustive matrix; review the semantic gaps neither can detect.

## Manual checks

- **Intent and interface contracts:** trace both sides of every changed interface. Confirm the implementation matches the PR and any Agent Note, including errors, cancellation, ownership, and disposal.
- **Lifecycle and concurrency:** for async setup, callbacks, processes, or teardown, apply the repository's defensive-patterns documentation. Check races before publication, cancellation during awaits, independent error reporting, callback containment, ownership before reentry, complete detach cleanup, and quiescent disposal.
- **Capability and consumer fit:** trace every current consumer, then flag consumer-specific behavior leaking into the interface under the package rules. Flag the inverse too: a new public method on a generic service (registry, session, agent) whose only caller is one internal consumer is an unnecessary API expansion — require a private capability closure handed to that consumer at construction instead.
- **Scope, ownership, and necessity:** map each abstraction, state machine, option, defensive copy, and compatibility path to its current contract, production consumer, and owning plugin or service. Challenge unrelated features and speculative generality, then test the PR against the repository's root conventions.
- **Configuration and public choices:** ask what current-consumer evidence or prior art supports each default, public operation set, format, or imported external concept. Require an explicit choice or deferral when that evidence is absent.
- **Model perspective:** inspect the exact prompts, tool schemas, results, and diagnostics the model receives across affected modes. Flag concepts outside the model's task, then verify stable text verbatim and dynamic behavior through snapshots or end-to-end coverage.
- **Enforcement:** follow every denial path to the operation that executes it; exercise direct and alternate callers that can bypass schemas, prompts, facades, wrappers, or listener ordering.
- **Borrowed and derived state:** determine whether each retained value is borrowed or owned under the package contract, then trace notifications and every cache, prompt, UI echo, replay, and query view to the documented success point and authoritative source.
- **Bounds cover the final operation:** locate the owner of the complete emitted or retained result, including wrappers and metadata. Probe tiny and exact limits, oversized single chunks, and multibyte text for byte limits.
- **Real entry path:** tests exercise the shipped loader, bin, worker, protocol bridge, or subprocess where relevant. A hand-mounted plugin does not catch invalid loader exports; a function plugin must named-export its namespace and have no default export.
- **Test strength:** assertions fail on the intended regression and verify external state, logs, events, or disposal rather than restating the implementation or trusting an agent's report. Coverage is necessary but not evidence that the scenario is correct.
- **Invariant lifecycle and negative controls:** verify candidate observations are rejected before publication where possible, session-backed checks reconstruct durable history after late loading or HMR, and a deliberately invalid case fails through the real runner for the intended rule.
- **Implemented Agent Notes match shipped reality:** when a PR implements a proposed Agent Note, move and rewrite it as present-tense shipped state in the same diff, then verify paths, names, and mechanisms against the implementation.
- **Transcript changes:** editor-visible or model-visible changes update snapshots or explain why no snapshot applies. Review expected-output diffs as behavior changes, not formatting noise.
- **Bilingual changes:** compare meaning and terminology on both sides; a green pairing hash does not prove translation quality.

## Reporting findings

State the defect, location, impact, and evidence. Place a localized defect inline on the tightest relevant diff range; use a PR-level comment for cross-cutting architecture, scope, or review-wide synthesis. Separate blockers from suggestions and omit issues already enforced by a green gate. Use the existing GitHub review thread for replies. When receiving review, verify each claim and fix or rebut it on technical grounds without performative agreement.
