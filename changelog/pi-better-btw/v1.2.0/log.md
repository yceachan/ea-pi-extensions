# pi-better-btw v1.2.0

## feat

- Merge [PR #5](https://github.com/yceachan/ea-pi-extensions/pull/5): independent side-chat model/thinking controls, searchable pickers, live layouts, native message navigation, themed panels, growing input and a busy/idle footer indicator. Thanks to [@De0ta](https://github.com/De0ta) for the contribution.
- Esc stops a running turn and keeps the chat open; when idle it hides the overlay while retaining the session, history and draft. Esc inside pickers/help returns to the chat. Alt+W continues to hide/restore without stopping generation.
- Alt+N is the sole user action that discards the side-chat session and starts an empty one, retaining side-chat model/thinking settings. Remove the close-confirmation flow, `/btw-close` and Alt+R.

## fix

- Complete `/btw` and `/side` commands when their overlay is mounted rather than when the side-chat session ends. Commands submitted after hiding now dispatch normally, avoiding queued reopenings and repeated close confirmations.
- Share pending mounts across rapid opens, surface asynchronous UI failures and prevent a pending reset from reopening a chat after host session teardown.

## chore

- Require Pi 1.4+ for the contributed UI/runtime integrations; retain the regular-mode mouse path.
- Register lifecycle regressions using Pi's actual submit, extension-command dispatch and custom UI methods with in-memory fullscreen and regular terminals; update both READMEs and shortcut help.
