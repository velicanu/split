# 03 — Splitting & balances engine

The money math. This lives in the shared [core algorithm spec](01-shared-contract.md) with golden
vectors, because every client must compute identical numbers.

## Money rules

- **Integer minor units (cents), never floats.**
- **Deterministic remainder distribution.** On a `$10 / 3` split someone eats the leftover cent;
  distribute remainder cents to the first N payers in a defined order so per-expense shares always
  sum exactly to the total. Pin this rule in the spec.

## Split modes

All resolve to per-person cents at entry time and are stored resolved (see
[02](02-data-model-and-ledger.md)):

- **Equal** — total split evenly, remainder distributed deterministically.
- **Exact** — explicit amounts per person (must sum to total).
- **Percentage** — percentages per person (must sum to 100%), then resolved to cents.
- **Shares / weights** — e.g. 2:1:1, resolved to cents.

## Balances

- **Pairwise balances** — per member-pair net of all expenses + settlements. Transparent and easy
  to explain to users. Computed on the fly from the ledger, cached, not persisted as truth.
- **Debt simplification (optional)** — collapse the graph into the fewest transactions
  (greedy max-creditor vs max-debtor / min-cash-flow). Keep it **opt-in**: some users distrust
  "why do I owe Sarah when I never spent money with her?"

## Conflict resolution (LWW)

- Appends never collide (unique `event_id`).
- For concurrent edits to the *same* event id, **highest `updated_at` wins**. LWW can silently
  drop the loser's edit — acceptable for this app, documented as a known tradeoff.
- Resolution is client-side (server is E2E-blind); the rule is part of the golden vectors.

## Open questions

- Tie-break when two edits share an identical `updated_at` (e.g. fall back to `event_id` ordering).
- Whether debt simplification is v1 or later.
