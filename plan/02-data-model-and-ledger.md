# 02 — Data model & event ledger

The domain, modelled as an append-only log of immutable events. Balances are *derived* from the
log, never stored as mutable truth.

## Entities

- **User** — an account; one universal identity reachable from any client (never per-app).
- **Group** — a named container with a set of members (e.g. "Ski Trip", "Apartment 4B").
- **Membership** — user ↔ group, with a role (admin/member) and status (active/invited/left).
  Uses a **stable member id** so keys can rotate without breaking ledger references.
- **Expense** — who paid, total amount, currency, date, category, and a set of shares.
- **Share** — expense ↔ member, the amount that member owes for *this* expense.
- **Settlement / Payment** — member A pays member B to square up (separate from expenses).

## Modelling decisions

- **Store shares as resolved amounts** (computed per-person cents), not just "split equally." UI
  offers split modes; we persist the computed result. Makes balances a simple sum and survives
  later membership changes.
- **Money in integer minor units (cents), never floats.** See
  [03](03-splitting-and-balances.md) for rounding.
- **Balances are derived, cached, never persisted as truth.** The ledger (expenses + settlements)
  is the single source of truth; mutable balance fields drift and are hell to debug.
- **Append-only.** "Editing" or "deleting" an expense is a new correcting event referencing the
  original `event_id`; the original is never mutated. This is what makes conflicts nearly vanish.

## Event shape

Every event: `event_id`, `group_id`, `author` (stable member id), `updated_at`, `schema_version`,
and a type-specific (encrypted) payload. Event types: `expense.created`, `expense.updated`,
`expense.deleted`, `settlement.created`, `member.added`, `member.removed`, `member.key_rotated`,
etc.

## Open questions

- Single-currency per group (ship first) vs per-expense FX rate + group home currency (decide the
  model now even if deferred — retrofitting currency is painful).
- Categories: fixed list vs free-form.
