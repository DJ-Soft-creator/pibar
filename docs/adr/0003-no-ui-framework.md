# 0003 – UI without a framework

Status: accepted
Date: 2026-10-31

## Context

The UI consists of two small windows with manageable state. A framework (React, Svelte, Vue) adds build complexity,
dependencies and onboarding effort.

## Decision

TypeScript without a framework. Elements are built with the small helper [`h`](../../src/shared/dom.ts), state lives
centrally in [`state`](../../src/main/state.ts), and each module has a `render…` function that rebuilds its area.
Pure logic without DOM belongs in [`format.ts`](../../src/shared/format.ts) and gets tests.

## Consequences

- Few dependencies (marked, DOMPurify, highlight.js), fast build.
- Re-evaluate if the UI grows a lot (e.g. diff view, many dialogs); moving to Svelte would be possible module by module.
