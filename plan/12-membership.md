# 12 — Ghosts, leaving, and who is in a group

One mechanism covers three things that looked separate: people who don't use the
app, people who leave, and people who lost their account. All of them are a
member id in the ledger with nobody currently attached to it.

## Ghost members

Any member — including the only member of a solo group — can add a **ghost**: a
member who represents a real person not using the app. Ghosts are *ledger-identical*
to real members. They pay for things, they take shares, they are owed and they
owe. Nothing in the splitting or balance maths knows the difference.

The only thing a ghost lacks is an account, so nobody reads the group as them.

### Ghost ids are negative

Server-issued user ids are positive; ghost ids are negative integers minted by
the client. Two reasons:

- **They cannot collide with a real user id**, which matters because splits name
  members by id and a collision would silently merge two people's money.
- **They stay numbers.** `splitEqually` sorts with `a - b` and `splitByWeights`
  does `map(Number)`; the Python reference sorts too. A string id would make
  `Number(id)` NaN, break the remainder tiebreak, and let two clients disagree
  about who gets the spare cent — the one failure the whole design exists to
  prevent.

## Leaving

Anyone may leave a group. Nobody can be removed by anyone else.

Leaving turns you into a ghost: **your balances do not change**, your history
stays exactly as it was, and the group carries on splitting with you as a name.
What ends is your access — the server drops your membership, so you stop
receiving the group, and the client drops what it holds.

This is tidiness, not a privacy boundary. A departed member keeps the group key
(we do not rotate) and may have exported the ledger, so leaving must never be
described as shutting someone out.

`member.left` is **self-authored**: payloads are encrypted, so the server cannot
check the claim, but it does set `author` on every event and that cannot be
forged. The fold therefore accepts a `member.left` only when
`author === member_id`, which is what makes "cannot be kicked" true rather than
merely intended.

When the last member leaves, the group is genuinely gone: the server deletes the
group, its events, its receipts and its wrapped keys. Membership count reaching
zero is one of the few rules the server can enforce without reading anything.

## Invites name a member

An invite link says *who to become*: `#join=<code>&gk=<key>&as=<member_id>`.
Accepting it joins the group and claims that member in one act, so there is no
window in which someone else could claim the ghost first, and nobody has to
remember to do it afterwards.

Hitting **invite** always produces a member to become. If you are inviting
someone already in the split, it is their existing ghost; otherwise a ghost is
created for them there and then, which means the group can split with them
before they ever accept.

**A member can only be claimed once** — the first merge naming it wins, later
ones are ignored. A link used twice would otherwise let the second person
silently displace the first, who would be left a member with no history and no
indication why. This does not affect recovery chains (`2 → 3` then `3 → 4`),
because a merge *target* is not itself a claimed id.

The `member.merged` event is unchanged, and remains available as the corrective
path when someone has already joined and needs attaching afterwards.

## Claiming a ghost

Someone who joins can be attached to an existing ghost — the ghost's history
becomes theirs. This is the same `member.merged` event that already handles
account recovery, and it needs no new machinery.

**Only a member with no ledger activity may claim a ghost.** No appearance as a
payer, in a split, or on either end of a settlement.

The rule exists to stop a merge being used as a financial move. Without it, a
member who owes £50 could claim a ghost who is owed £50 and cancel their debt
with someone else's credit. Requiring a clean slate means a merge can only ever
*give* you the ghost's position, never net off your own.

Two honest limits:

- It does **not** prevent appropriating a credit. Someone with no activity can
  still claim a ghost who is owed money and walk off with the claim. What guards
  that is the log — every merge is visible — and the fact that you are publicly
  asserting you are that person.
- "No activity" is stricter than "zero balance". Someone who joined, spent, and
  settled back to exactly zero is refused. That is rare, and the alternative
  requires the fold to carry running balances so it can evaluate a merge against
  the balance at that moment — a restructure of the money-critical path, for a
  case nobody has yet wanted.

## Events

```
member.ghost_added { member_id, display_name }   any member may add
member.left        { member_id }                 accepted only if author matches
member.merged      { old_member_id, new_member_id }   claimer must be unused
```

All are encrypted like any other payload. `member.added` remains the exception:
the server writes it, so it stays in the clear.

## Deliberately not doing

- **Archiving** — staying in a group but hiding it from the default view. Wanted
  eventually; leaving is the destructive version and is what people ask for
  first.
- **Group key rotation on leave.** Consistent with member removal generally, and
  the reason leaving is presented as tidying rather than security.
- **Any form of removal by others.** A group is a set of people who each chose to
  be there.
