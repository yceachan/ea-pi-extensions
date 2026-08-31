# pi-wsl-browser v0.1.0

## feat
- add session-scoped Microsoft Edge and Chrome leases from WSL with headless, temporary-profile, and main-profile modes.
- bundle a pinned browser-harness runtime, secure session descriptor wrapper, and `wsl_browser` lifecycle tool without taking ownership of existing user tabs or browser processes.
- include automatic Windows browser/path discovery, user configuration, diagnostics, and the browser-harness skill for agent workflows.
- integrate managed controller logs and lifecycle cleanup with `pi-shelld`, including CDP readiness checks and isolated per-session runtime directories.

## test
- cover the TypeScript controller, protocol, path boundaries, package surface, and pinned Python runtime in the default workspace test suite.
