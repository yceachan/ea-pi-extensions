# pi-shelld v0.3.0

## feat
- let `pi-shelld:service:v1` consumers provide per-process environment overlays while preserving the parent environment and allowing inherited keys to be removed explicitly.

## test
- register package tests in the default workspace suite and cover environment merge, override, removal, and parent-process isolation behavior.
