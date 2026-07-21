# 14 — Read-only sharing

A link you can drop in a chat. Anyone who opens it sees the group — balances,
expenses, payments — without an account. Anyone who has an account can also
join from it, becoming a new member or claiming a ghost. Opt-in, and revocable.

## The one thing that was hard

Rendering a group needs two things: the **group key**, to decrypt, and the
**encrypted feed**, from the server. The key was already solved the invite way —
carried in the URL fragment (`gk`), which never reaches the server. The blocker
was the feed: `get_events` required an authenticated member, and a person with
no account cannot authenticate at all.

So the whole feature reduces to: **let the server serve the (opaque) feed to
someone presenting a read capability instead of a session.**

## The read token

A group gains an opt-in `read_token` (nullable, off by default). A member turns
it on; the server then serves the feed and the group name to anyone presenting
the token. The capability split stays crisp, and keeps the server blind:

- **`read_token` → the server**, as a header (`X-Read-Token`), not a query
  param — query strings leak via logs and `Referer`. It is a coarse gate the
  server issued and checks with a constant-time compare, against that group's
  own token only. It reveals nothing; the server already holds the ciphertext.
- **`gk` → the client only.** Decrypts. Never sent.

The share link is `#view=<id>&gk=<key>&rt=<token>&jc=<join code?>`. The join code
rides as `jc`, deliberately not `join`, so `parseInvite` does not mistake a view
link for an invite and auto-accept it — a view link shows the group first and
lets an account-holder *choose* to join.

## "Read-only" is enforced, not just hidden

Hiding the edit UI is cosmetic; the enforcement is underneath it. Writes go
through `require_writable_member` — a **session and membership**. A token-bearer
has neither, so even one poking the API directly cannot write. Read-sharing is
purely additive: a second *read* path, no write path near it. Membership,
ghosting cuts, none of it changes. A token reader is not a member and has no
cut, so they see the whole current feed.

The group meta served to a token reader carries the name but **not the join
code** — the code is the write capability and travels only in the link's
fragment, for account-holders.

## Joining from the view

Reuses what exists. An account-holder sees a Join affordance: "join as a new
member" (`join_group` with no `claims`) or, for each ghost, "I'm <name>"
(`join_group` with `claims`, server-enforced once). On success the key is sealed
to their account and the app reloads into the ordinary group. No new endpoint.

## Honest limits (the familiar family)

- **A view link is a bearer read capability.** Whoever sees it can read the
  whole group, because it carries the key. Revoking — clear or rotate the
  `read_token` — stops *future* fetches with that token; it does not rotate the
  group key (we never do) or un-see what someone already loaded. Same limit as
  invite links and receipts.
- **Off by default, on purpose.** An invite already lets someone join then read;
  a view link lets someone read *without joining*, which is strictly more
  public, so it is a separate switch, never implied by an invite being out.
- **Anonymous readers are indistinguishable** to the server — no identity, no
  view audit. Fine for read-only; stated so nobody expects otherwise.

## Deliberately not doing

- **A first-party rendezvous for the link.** It is an ordinary URL; where it is
  shared is the user's business.
- **Per-reader tokens or view counts.** One token per group; revocation is
  all-or-nothing per group, which is the granularity that matches "turn the
  link off".
