# Trusted Privileged Activation

Purpose: verify that host-page scripts cannot synthesize panel events that capture or delete encrypted originals, while ordinary trusted user interaction and non-destructive shortcuts continue to work.

## Product Rules

- Original capture, repair, original deletion, and record removal paths that can clean up linked encrypted storage require a trusted browser user event.
- Queue and Recent `Delete original` controls keep their two-step confirmation. An untrusted event must not enter confirmation or complete deletion.
- Every global page shortcut requires trusted activation, including navigation: stepping starts extension-privileged image requests, so a host-page script must not be able to drive it.
- Selected-Recent Backspace removal requires trusted activation.
- Trusted navigation, selection, Help, Settings, focus, and row/shadow-root propagation keep their existing behavior.

## Manual Acceptance

1. Load the unpacked E2E build and select a host image.
2. Use the primary `Capture original` button, then use `C` and `B`; confirm each real user activation starts its existing capture workflow.
3. In Queue, use `Capture`, `Repair selected originals`, `Delete original`, and `Delete`; confirm each real user activation retains its existing behavior.
4. In Recents, use `Capture`, `Delete original`, `Remove`, `Delete recents`, and selected-row Backspace; confirm each real user activation retains its existing behavior.
5. In Settings, complete both confirmation steps for current-Queue and Recall deletion; confirm real user activation remains required at both steps.
6. From a host-page script or the browser console, dispatch synthetic `click` events at the same controls.
7. Confirm no capture, repair, removal, or deletion action starts and that `Delete original` and Settings destructive controls do not enter confirmation.
8. Dispatch synthetic document `keydown` events for `C`, `B`, and ArrowDown while ArrowDown is configured for capture.
9. Confirm no privileged shortcut action is dispatched.
10. Dispatch synthetic ArrowLeft, ArrowRight, Help, Settings, and Escape shortcuts; confirm none is routed.
11. Press the same keys and exercise Queue/Recent row selection and focus; confirm the behavior and row/shadow-root propagation remain unchanged.

## Automated Coverage

- `tests/dom/manual-controls-view.test.ts`: primary Capture original rejects synthetic clicks and accepts trusted activation.
- `tests/dom/bookmarks-view.test.ts`: Queue capture, repair, original deletion confirmation, and record deletion cover synthetic and trusted activation.
- `tests/dom/history-view.test.ts`: Recent capture, original deletion confirmation, row/bulk removal, and Backspace cover synthetic and trusted activation.
- `tests/dom/maintenance-settings-view.test.ts`: destructive Settings confirmation cannot be advanced synthetically.
- `tests/dom/keyboard-router.test.ts`: every synthetic shortcut is rejected and the same keys route when trusted.

## Expected Result

- No synthetic host-page DOM event can dispatch the covered capture or destructive workflows.
- Trusted pointer and keyboard actions retain their existing behavior.
- Synthetic events never advance either confirmation step.
- No synthetic key event is routed as a shortcut.
- Trusted keyboard routing, row focus, and event propagation remain intact.
