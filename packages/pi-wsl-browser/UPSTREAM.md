# browser-harness fork baseline

- Upstream project: <https://github.com/browser-use/browser-harness>
- Baseline package: `browser-harness==0.1.9`
- Baseline tag/commit: `v0.1.9` / `41108b8676d4bdb58b26ab3b079c0b7b0f8f3926`
- License: MIT (retain the upstream license in the vendored runtime)
- Runtime entrypoints: `python -m browser_harness.daemon` and `python -m browser_harness.run`

The package runtime is pinned. It must not download, self-update, or switch to a newer upstream release while an agent is running.

## Local managed-mode patch surface

The fork should keep upstream page/CDP helpers intact while applying only these managed-session gates:

- hold one CDP connection per Pi session through the managed daemon;
- accept lifecycle requests only on the private control socket and validate the controller token;
- claim the exact root target carrying the controller marker and track opener descendants;
- reject agent-created/closed targets and attachments outside the owned tree;
- require an active lease for `python -m browser_harness.run` and never recover by attaching the first page;
- leave cloud, updater, and generic browser auto-discovery paths unreachable in managed mode.

When updating the fork, compare the two pinned entrypoints, target helpers, daemon recovery, and the upstream Skill before changing this package. Update this file and the package tests in the same review.
