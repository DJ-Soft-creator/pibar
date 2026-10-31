# 0001 – Tauri 2 with a Rust core and web UI

Status: accepted
Date: 2026-10-31

## Context

PiBar should be a lean desktop app for Pi: chat with Markdown, sessions, files, plus a global quick bar. Target
platform macOS first, later Linux and Windows. Considered: SwiftUI (native, macOS only), Rust with a native GUI
(egui/iced) and Tauri.

## Decision

Tauri 2: Rust core for processes, SSH, files, hotkeys and screenshots; UI in HTML/CSS/TypeScript, shown in the system
WebView.

## Consequences

- One code base for macOS, Linux and Windows. Only OS-specific parts (double tap, area screenshot, OCR) need code per
  platform, see [`quick.rs`](../../src-tauri/src/quick.rs).
- Chat, Markdown and code highlighting are easy with web technology.
- Small app, since no browser is bundled; the look is not fully native.
- Development needs Rust, Node.js and, on macOS, the Xcode Command Line Tools.
