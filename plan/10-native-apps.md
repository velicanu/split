# 10 — Native apps (later)

Native clients ship *after* the PWA. They are an **additive** project, not a rewrite, because they
speak the same [shared contract](01-shared-contract.md) — same event schema, same core algorithm
spec, same crypto suite. Interop (including the same user on PWA *and* native seeing the same data)
is a property of the contract.

## What native buys us

- **OS on-device AI** — reach Gemini Nano (Android, via ML Kit GenAI) and Foundation Models (iOS)
  through platform plugins, which a pure PWA cannot (see [09](09-ai-features.md)).
- Better OS integration (notifications, share sheet, camera/document scanning, home-screen
  presence beyond PWA install).

## Approach

- **Wrap-vs-rebuild:** a thin native shell (**Capacitor** or **Tauri**, or a **TWA** on Android)
  lets the web codebase run largely as-is while native plugins expose the NPU and OS features.
  Full native rebuild is an option later if the shell limits us.
- The client stays a thin renderer over the ledger; all canonical logic remains the shared spec.

## Must-not-break invariants (protect from the first PWA commit)

- **Stable member id + rotatable keys** so recovery/identity works across clients
  (see [07](07-key-recovery.md)).
- **Identical crypto suite** — a blob encrypted by the PWA must decrypt on native for the same
  user. Pinned in [01](01-shared-contract.md).
- **Same golden vectors pass** on native's implementation of the core algorithm.

## The App Store ↔ AGPL tension

Pure GPL/AGPL apps **conflict with the Apple App Store terms** (the VLC saga: App Store usage
restrictions/DRM that (A)GPL forbids). To ship our own iOS binary cleanly:

- Hold the copyright ourselves (solo, or via a **CLA/DCO** from contributors), then grant an
  **additional distribution exception** or **dual-license** our own binary.
- This is why the plan calls for adding a **CLA from commit one** — it preserves both dual-licensing
  and clean App Store distribution.

## Open questions

- Capacitor vs Tauri vs full native.
- Whether Android ships first (TWA is low-friction) before iOS.
- Timing: after which PWA milestone do we start native?
