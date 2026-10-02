# pi-better-btw v1.1.0

## feat

- Support Pi 1.0's default fullscreen TUI through component mouse dispatch: wheel scrolling, captured drag selection, double-click line selection, and retained-selection copying with Ctrl+C / Ctrl+Shift+C.
- Forward fullscreen input-area clicks to Pi's editor for mouse cursor positioning while keeping overlay shortcuts active.

## fix

- Keep fullscreen mouse reporting under Pi's ownership when opening, backgrounding, restoring, or closing the side chat; preserve visibility-bound SGR reporting in regular mode.
- Use dispatched overlay coordinates and actual render widths for selection hit-testing, include the last content column on overshoot, and finish captures on modified or buttonless releases.
- Adapt extension tool wrapping to Pi 1.0's tool execution context.

## chore

- Update Pi development dependencies to 1.0.0 and add in-memory renderer regression coverage for both TUI modes; clipboard tests no longer depend on desktop commands.
- Document fullscreen mouse support and lifecycle behavior in both READMEs.
