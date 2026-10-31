# 0004 – OCR with Apple Vision, double tap via CGEventTap

Status: accepted
Date: 2026-10-31

## Context

The quick bar should pass screen content to Pi as an image or text and open with a double tap on ⌥, like other
assistants. Both need operating system interfaces.

## Decision

- **Screenshot:** the macOS tool `screencapture` (interactive area), on Linux `import`/`gnome-screenshot`
  ([`capture`](../../src-tauri/src/quick.rs)).
- **OCR:** Apple Vision via a small Swift program that is compiled with `xcrun swiftc` on first use and cached in the
  app data folder ([`mac_ocr_helper`](../../src-tauri/src/quick.rs)); otherwise `tesseract`.
- **Double tap:** passive `CGEventTap` on modifier changes; the detection itself is platform independent and tested
  ([`Detector`](../../src-tauri/src/doubletap.rs)).

## Consequences

- No extra Rust dependencies for OCR; the Xcode tools are required on the Mac.
- macOS asks for "Screen Recording" and "Input Monitoring".
- Linux and Windows need their own double-tap code; until then only the key combination works there.
