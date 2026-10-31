# Architecture decisions (ADR)

Short notes on decisions that cannot be read from the code later: what was decided, why, and what follows. One file
per decision, numbered. A superseded decision is not deleted but set to "superseded by NNNN".

| No. | Decision | Status |
| --- | --- | --- |
| [0001](0001-tauri.md) | Tauri 2 with a Rust core and web UI | accepted |
| [0002](0002-pi-rpc-over-ssh.md) | Pi in RPC mode, remote hosts directly over SSH, no extra service | accepted |
| [0003](0003-no-ui-framework.md) | UI without a framework | accepted |
| [0004](0004-ocr-and-double-tap-macos.md) | OCR with Apple Vision, double tap via CGEventTap (macOS only) | accepted |
| [0005](0005-i18n.md) | Translations without a library, English text as key | accepted |

Template for new ADRs:

```markdown
# NNNN – Title

Status: proposed | accepted | superseded by NNNN
Date: YYYY-MM-DD

## Context
## Decision
## Consequences
```
