# 18 — Liquid-glass UI

A visual language for the whole app: frosted "liquid glass" surfaces over a slow,
ambient colour field, a single green gradient for the one primary action per
screen, pill geometry, and springy taps. Extracted from a clickable mockup
(`velicanu.com/upload/mockup4.html`, "Split — liquid glass mockup"), which
prototypes **every** screen — not just the ones we ship today.

This doc records the design system, what shipped in the first pass, and the
screen-by-screen work still to do. It is a UI/UX plan; it changes no crypto, no
event schema, no server contract.

## The design system (extracted verbatim)

Tokens now live in `pwa/src/style.css`, theme-aware (light default + dark). The
mockup is **dark-only**; dark reproduces its recipe, light is a faithful
translation (near-white panes over a pale pastel wash).

| Token | Dark (mockup) | Light (translation) |
|---|---|---|
| `--glass` | `rgba(255,255,255,.085)` | `rgba(255,255,255,.66)` |
| `--glass-hi` | `rgba(255,255,255,.16)` | `rgba(255,255,255,.85)` |
| `--stroke` | `rgba(255,255,255,.17)` | `rgba(15,23,42,.10)` |
| `--glass-blur` | `blur(22px) saturate(170%)` | `blur(20px) saturate(150%)` |
| `--accent-grad` | green gradient `#5eeb96→#20b460` | `#34d778→#16a34a` |
| `--glow-1..4` | teal / blue / violet / teal | pastel equivalents |
| `--radius-pill` | `24px` | `24px` |
| `--spring` | `cubic-bezier(.3,1.4,.6,1)` | same |

**The glass recipe** (one declaration, reused): `background: var(--glass)` +
`backdrop-filter: var(--glass-blur)` + `1px var(--stroke)` border + a
double shadow (`--glass-inset` highlight on top, `--glass-shadow` drop below).

**The ambient field** (`#bg` in `index.html`): four blurred, slow-drifting radial
blobs, `z-index:-1`, `pointer-events:none`, disabled under
`prefers-reduced-motion`. Vivid in dark, toned down in light via `--glow-opacity`.

**Primary vs. tonal.** Exactly one green gradient button per screen (the thing to
press); everything secondary is a frosted `.tonal` button. Selected states in
segmented controls / chips go **solid white with dark text**, not green.

## What shipped in the first pass (this PR)

Applied through the shared primitives our components already use, so every screen
inherits the look without touching each one:

- **Tokens + ambient background** — the table above, plus `#bg`.
- **Primitives restyled:** `button` (gradient primary + `.tonal` + springy
  `:active`), `input` / `select` (glass pills with a focus ring), `.row` (the
  workhorse surface — group / expense / settle / settings rows), `.segmented`
  (capsule, solid-white selected), `.method` (glass card).
- **Auth front door → mockup fidelity:** gradient `.wordmark`, passkey as the
  green primary, password + recovery as tonal cards, glass handle field, ambient
  glow. Verified by rendering the built app in light **and** dark.

Deviations from the mockup, on purpose:

- **Segmented selection does not grow** (`flex-grow`). The mockup widens the
  selected tab; for the auth nav the user specifically chose invariant, non-
  jumping tabs (PRs #62–#64), so we keep them equal-width.
- **Light mode kept.** The mockup is dark-only. We did not force dark, so the
  existing theme toggle still works. → *open decision below.*

## Gap analysis — mockup screens vs. the real app

| Mockup screen | Real app today | Gap |
|---|---|---|
| Auth: sign in / sign up / pair | `Auth.jsx` | **Done** — reskinned 1:1. |
| Save recovery code | `Auth.jsx` recovery view | Reskinned via primitives; minor layout polish left (stack Copy tonal above green primary). |
| Home / Groups + **total-balance hero** | `Home.jsx` + `GroupList.jsx` | Hero card, group **emoji**, per-group "you owe / settled up", **bottom tab dock** are all net-new. |
| Group → **Expenses** | `GroupView.jsx` | Reskinned rows; needs per-row "you lent / you owe", receipt-glyph avatar, **FAB**. |
| Group → **Balances / settle-up** | ledger math exists (`ledger.js`, `settle.jsx`) | **No dedicated Balances view.** Net-balances card + suggested settle-ups list is net-new UI over existing math. |
| **Activity** feed (cross-group) | — | **Net-new screen.** A merged, dated feed of events across all groups. |
| Settings hub | `Settings.jsx` | Reskinned; needs the mockup's grouped layout (profile card, Devices & keys, App) + "Passkeys (N registered)" summary. |
| Pair a new device (old side) | `PairOldDevice.jsx` | Reskinned; camera/QR affordance + code entry polish. |
| **Add-expense sheet** w/ split modes | `ExpenseForm.jsx` | Bottom-sheet presentation + **Exact / % / Shares** chips (only Equal today). |
| Pairing-approval sheet (emoji SAS) | `PairOldDevice.jsx` fingerprint | Reskinned; bottom-sheet presentation. |

## Rollout — remaining phases

Ordered cheapest-first. Each is independently shippable behind the primitives
already in place.

**A. Screen-level polish (pure CSS/markup, no new features).**
Walk `GroupView`, `GroupList`, `Settings`, `ExpenseForm`, `PairOldDevice`,
`BillCreate/Claim`, `ReadOnlyGroup` and lift each to the glass layout: card
headers, `.amt` pos/neg colouring, receipt-glyph avatars, section titles.
Dark-mode pass on each. Verify with the Playwright shot rig against a live
session (`scripts/live.sh` gives a real signed-in app to screenshot).

**B. Navigation shell + FAB + bottom dock.**
The mockup replaces our text header (`brand · spacer · settings · log out`) with
a floating glass **bottom dock** (Groups / Activity / Settings) and a green
**FAB** for the primary create action. This is the biggest structural change:
`Home.jsx` becomes a shell hosting a tabbed view. Keep the URL-fragment routing
(`nav.js` / `useView.js`); the dock just drives it. Decide: dock only when
signed in; how the FAB's action changes per screen (add expense in a group, new
group on Home).

**C. Home hero + group emoji.**
A `card.hero` showing aggregate balance across groups ("−$85.03 you owe"), tinted
green when owed-to / red when owing. Needs a cross-group balance sum (fold each
group's ledger, already possible client-side). Per-group **emoji**: a new
optional field on the group's encrypted metadata — pick-on-create, default by
hash. Small schema-adjacent change (encrypted blob only; server stays blind).

**D. Balances / settle-up view.**
A second tab inside a group (Expenses ⇄ Balances segmented control). "Net
balances" per member + "Suggested settle-ups" (fewest-transactions
simplification) with per-line Settle buttons. The math exists (`ledger.js`,
`resolveSplit`, `settle.jsx`); this is presentation + wiring the settle action.
The mockup labels simplification "opt-in in real app" — keep it a toggle.

**E. Split modes (Exact / % / Shares).**
`ExpenseForm` today is Equal-only. Add the mode chips + per-mode inputs. The
engine is speced in [03](03-splitting-and-balances.md) and partly in `split.js`
(`resolveSplit` / `resolvePayers`); this surfaces it. Needs care: validation
(percentages sum to 100, shares are positive ints), and the ledger event already
carries enough to represent non-equal splits — confirm before building.

**F. Activity feed.**
A cross-group, reverse-chronological feed built from the same event ledgers we
already sync ("You added 'Gas' in Ski Trip · $54.20", "You settled up with Jo").
Read-only projection over existing events; no new server data. New `Activity.jsx`
+ a fold that merges per-group event logs with group context.

**G. Sheets.**
Present add-expense and pairing-approval as bottom sheets (`#sheet` recipe:
frosted, `translateY` spring-up, grab handle, scrim) rather than inline screens.
Cross-cutting `Sheet` component; adopt where the mockup uses one.

## Open decisions

1. **Dark by default?** The mockup is dark-only and clearly designed for it (the
   glass reads best over the dark ambient field). We kept light + the toggle.
   Options: (a) keep system-preference default as today; (b) default new users to
   dark, toggle still available; (c) go dark-only and drop the light palette.
   Recommend (b) unless we want to shed the light-mode maintenance.
2. **Group emoji storage** (phase C) — a field on the encrypted group metadata.
   Confirm where group metadata is sealed today and add one optional key; the
   server never sees it.
3. **Simplification default** (phase D) — mockup says opt-in. Keep off by default.
4. **`backdrop-filter` fallbacks** — a handful of older browsers ignore it; the
   `--glass` alpha still yields a usable translucent panel, but check contrast on
   the tonal-white-on-light case before relying on the blur.
