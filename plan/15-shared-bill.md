# 15 — Shared bill

A standalone way to split one receipt. You scan a bill in your logged-in view,
publish a link, and everyone who opens it claims the items that were theirs — no
account needed to claim. The split falls out the same way it does in a group:
an item claimed by N people splits N ways, tax and tip ride along proportionally,
and because more than one person can have paid, the result is who-owes-whom, not
just a per-head number.

It reuses almost everything. The one genuinely new thing is that **people
without accounts write shared state** — which read-only sharing (plan/14)
deliberately forbids. This doc is mostly about doing that safely.

## The shape

A **bill** is a new server resource, standalone — not a group, not an expense.
It has two halves, and the split between them is the whole design:

- **A static snapshot**, set once by the authenticated creator: the receipt
  image, the line items (`{id, name, price_cents}`), who paid and how much
  (`{name, paid_cents}`, possibly several), and tax / tip / total. Sealed under
  a fresh **bill key** at creation and never changed after. This is the scan
  result plus who-paid — exactly the receipt-items expense you already build,
  frozen.
- **A mutable claim set**, written by whoever opens the link: a list of
  **participants** and, per participant, which item ids they claim.

Only the claim set moves. The scan, the items, and the payers are done.

## Joining is identical to a group

The creator can **seed ghosts** at creation — the diners they already know, by
name — so the table previews before the link goes out. Anyone opening the link
then does exactly what an account-holder does on a group invite: **claim a
ghost** ("I'm Sam") or **join as a new person**, then claim their items. Both
paths are open at once, same as a group.

The catch is that a group backs that UX with accounts — your membership is
*yours* because it is sealed to your device key, and claim-once is enforced
because the server writes `member.added` in the clear. A link-claimer has no
account, so we need an account-less stand-in for "this identity is mine."

## The join secret — an account-less membership

When you claim a ghost or join new, your browser mints a random **join secret**
and the server **binds that participant to it, first bind wins**. That single
mechanism carries both properties the group gets from accounts:

- **Claim-once.** A ghost is bound the first time someone claims it; a second
  browser presenting a different secret gets a 409. Same as `join_group`
  enforcing a claim once.
- **Your claims are yours.** Editing a participant's claims requires that
  participant's secret, so nobody else with the link can un-claim your items.

The secret is a bearer capability the server stores and compares (constant-time,
like `read_token`), never user content — it reveals nothing, and the server is
still blind to names and claims, which stay sealed under the bill key. The
browser remembers its `(participant_id, secret)` locally, so a refresh comes
back as the same person.

> We could instead let anyone with the link edit anyone's claims — a group *does*
> allow any member to re-split any expense (last write wins). But claim-once for
> ghosts needs a per-claimer secret to be meaningful at all (otherwise "first
> wins" can't tell a re-claim from a steal), and once that secret exists, gating
> claim-writes with it is nearly free and much easier to reason about. So we do.

## The capabilities in the link

The link fragment carries the **bill key** (`k`) — decrypts, never sent — and a
**bill token** (`t`) — the server-checked bearer gate for reading the bill and
for joining. Mint-a-participant and edit-my-claims additionally present the
per-participant **join secret**. So:

- `k` → client only. Decrypts the snapshot and every participant's sealed name
  and claims.
- `t` → server, as a header. Read the sealed bill + join. Coarse gate, reveals
  nothing.
- join secret → server, per write, proves "I am this participant".

## Why (b): a parallel resource, not the group system

The group's write path is welded to accounts — device keys, sessions,
`require_writable_member`, membership rows. Threading "no account" through all
of that would be invasive and risky for a model that doesn't want accounts. So
the bill is its **own small resource** that reuses the *pure* pieces and owns its
own account-less endpoints:

- **Reused as-is:** the scan (`extractReceipt`), content-addressed receipt
  storage + fetch-with-token (plan/14 already lets a token-bearer pull a receipt
  image), the crypto, the read-only-style account-less bootstrap, and the split
  maths — `receiptWeights` → `splitByWeights` for shares, and `simplify` to turn
  payers-vs-claimers into a short list of who pays whom.
- **New, and small:** create-bill (authenticated), get-bill (token), join /
  claim-ghost (token, mints or binds a secret), set-my-claims (secret). Plus a
  claim view that mirrors `ReadOnlyGroup` but *writes* the claim set.

The group model is left completely untouched.

## Unclaimed items are held aside, not spread

Mid-claiming, some items are nobody's yet. In a group `receiptWeights` splits an
unclaimed item across *everyone* (`targets = claimed.length ? claimed :
participantIds`) — right for a settled expense, wrong for a live table, where it
would silently bill you for a dish you didn't order. So the bill view feeds only
claimed items into the maths and shows the rest as a visible **"unclaimed —
$X.XX"** line. Each person owes only what they took; the host can see what's
still up for grabs. Tax and tip follow the claimed items, so the unallocated
remainder is honest too.

## Honest limits (the familiar family)

- **The link is a bearer read+join capability.** Anyone who sees it can read the
  bill and join it, because it carries the key and token — the digital version
  of the paper bill going round the table. The join secret means they can't edit
  *your* claims, and ghosts are claim-once, but a griefer with the link can still
  join as extra people or claim loose items. Fine for a dinner; stated plainly.
- **Identity is asserted, not proven.** "I'm Sam" is a claim, like taking a name
  tag. There is no verification, by design.
- **Anonymous participants are indistinguishable** to the server — sealed names,
  no audit. Same posture as read-only sharing.
- **Revocation is coarse.** Clearing the bill token stops future fetches with it;
  it does not rotate the key or un-see what someone already loaded — the same
  limit as invite, view, and receipt links.

## Deliberately not doing

- **Tying the bill to a group.** It is standalone. (Saving a finished bill *into*
  a group as an ordinary expense is a plausible later nicety, not v1.)
- **A "close / settled" state.** v1 stays live; the bill is GC'd by age. A formal
  close can come later if it's wanted.
- **Real accounts for claimers.** The whole point is that claiming needs none.
- **Per-claimer view audit or link analytics.** Out of scope, same as plan/14.
