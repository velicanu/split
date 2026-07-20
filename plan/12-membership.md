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

## Leaving, and ghosting someone else

**Anyone may ghost anyone, themselves included.** Leaving is ghosting yourself.

Ghosting turns a member into a ghost: **their balances do not change**, their
history stays exactly as it was, and the group carries on splitting with them as
a name.

The reason this is not a hostile act is that it **takes nothing away**. The
server keeps serving a ghosted member the group, capped at the event that
ghosted them — `memberships.until_event_id`. They keep everything they already
had; they simply stop receiving what comes after.

That cap is what makes the whole thing sound. The cut is **a position in the
log, not a moment in time**, so it does not matter whether the ghosted member
syncs a second later or a year later: they see exactly the prefix, and always
the same prefix. There is nothing to race.

A ghosted member may **read but not write**. Writing would be a one-way
conversation into a ledger nobody is listening to. What they get instead is
[revive](#revive), which is a place to carry on that people can actually see.

This is tidiness, not a privacy boundary. A ghosted member keeps the group key
(we do not rotate) and may have exported the ledger, so it must never be
described as shutting someone out.

When nobody is left reading a group, it is genuinely gone: the server deletes the
group, its events, its receipts and its wrapped keys. Membership reaching zero is
one of the few rules the server can enforce without reading anything.

### Ghosting is not relative

`member.left { B }` means B is a ghost in **every** reading of the log,
including B's own. The fold stays a pure function of the events, with no
viewer parameter.

The alternative — B's own fold showing B as live and everyone else as ghosts —
was considered and rejected. It reads well, but `ghost` is exactly the set of
ids an invite link may name, so a self-ghosting reader could invite someone to
become themselves, and their fork would contain no live member at all. Making
ghost status depend on who is asking also puts a viewer into the one function
the whole design needs to be reproducible.

B's fork is real instead: see below.

## Revive

A ghosted member opens the group and finds it frozen, with one thing to do:
**revive**. That clones the prefix into a brand-new group in which they are the
sole real member and everyone else is a ghost.

This is what makes the read-only rule honest. Without it, "read but not write"
is an artifact of there being one shared `events` table and nowhere to fork to.
With it, the fork is an actual group with its own log, its own key, and no
restrictions.

### Replay, don't assert

The clone **replays the prefix** — every expense and settlement, with member
references remapped. It does not open with a balance.

Opening with net balances would be a fraction of the code, but it would be the
first event in the system that *asserts* a number rather than deriving one, and
every balance being derived from the log is the premise the whole design rests
on. Not worth spending here.

The remap is the risky part, and the risk is quiet: a missed reference does not
raise, it silently moves money. It must cover payers, splits, the split recipe
(participants, item claims, weights), and both ends of a settlement.

- **Every member other than the reviver becomes a fresh negative ghost id.**
  The reviver keeps their own id.
- **Work from resolved ids.** The prefix may contain claims (`member.added`
  with `claims` set); the fold already resolves those, and the clone remaps
  what the fold resolved to, so claim chains are absorbed rather than replayed.
- **`member.left` is not replayed.** Everyone but the reviver is already a
  ghost in the new group, so prior ghosting is absorbed too.

The test that matters: **the new group's balances equal the old group's
balances at the cut**, over a log exercising every payload shape.

### The old group is hidden, not deleted

Revive does not delete the membership row. The row is already capped, and
`live` counts only uncapped rows, so it never held the group open anyway —
deleting it would buy nothing and would take the reviver's receipts with it
before we have decided what receipts should do.

Hiding is `memberships.hidden`, set by the reviver on their own row. An earlier
draft of this document claimed hiding needed no server change, on the grounds
that the client could infer it from `group.revived_from` in the new log. That
was wrong: the group list is served before any log has been folded, so the
client does not yet know what to hide, and a purely local flag would not follow
the user to their other devices. One column, honestly, is better than either.

`group.revived_from` is still written, as the first event of the new group. Its
job is provenance — a ledger that would otherwise appear from nowhere says
where it came from — not hiding.

Revive stays available indefinitely for anyone who does not press it straight
away, and a hidden group can be unhidden.

### What does not come across

Two things stay behind, and the revive screen has to say so rather than let
them disappear quietly:

- **Receipts** — sealed under the old group key and keyed by group, so carrying
  them means re-encrypting every one. See *Deliberately not doing*.
- **Comments** — the fold takes a comment's author from the *event* author,
  which the server records and nobody can forge. Replayed comments are all
  signed by the reviver, so carrying them across would attribute everyone's
  remarks to one person. Fixing that means a payload `author` field the fold
  trusts over the signed one, which trades a real guarantee for a nicety.
  Silently misattributing is worse than not carrying them, so they stay.

Neither affects a single balance, which is what makes leaving them behind
tolerable.

### Why not "only you may leave"

Account recovery needs someone *else* to act: a person who has lost their account
cannot ghost themselves. Requiring self-authorship would leave the one case the
whole ghost mechanism exists for unreachable.

The alternative considered — inviting someone to take over a member id that is
still active — is worse. It reattributes a live member's history while they are
still connected, so their next sync silently makes them somebody else. Ghosting
first severs the feed at a clean point, which is exactly why the fork is
comprehensible.

## Invites name a member

An invite link says *who to become*: `#join=<code>&gk=<key>&as=<member_id>`.
Accepting it joins the group and claims that member in one act, so there is no
window in which someone else could claim the ghost first, and nobody has to
remember to do it afterwards.

Hitting **invite** always produces a member to become. If you are inviting
someone already in the split, it is their existing ghost; otherwise a ghost is
created for them there and then, which means the group can split with them
before they ever accept.

## Claiming a ghost

**Claiming happens at the moment of joining, and nowhere else.** There is no
event an existing member can write to become somebody else.

The claim is a field on the join itself:

```
member.added { user_id, display_name, claims }
```

`claims` is the member id from the invite's `as=`. Accepting an invite is one
server-side act: validate the code, check the id is not already claimed, write
the join.

### Why this is a field and not an event

An earlier design had a standalone `member.merged` that anyone could write,
guarded by a rule that the claimer must have no ledger activity. The rule was
there to stop a merge being used as a financial move — someone who owed £50
claiming a ghost owed £50, cancelling their debt with someone else's credit.

Once invites name a member, the guard is protecting a door that no longer needs
to exist. A rule saying "only a fresh joiner may claim" still describes
something an existing member can attempt; making the claim part of the join
means there is nothing to attempt. Both the rule and the event are gone, along
with the fold's set of financially-active members that existed only to evaluate
it.

**This buys a real enforcement upgrade.** `member.added` is the one event the
server writes, in the clear, so *claimed at most once* is now checked by the
server rather than by every client agreeing to honour it. Under the old design
a modified client could simply skip the check. This is one of the few rules in
an end-to-end encrypted design that can be made to actually bind, which is
reason enough to prefer it.

The price is that the server learns *which slot* a joiner claimed — "user 7 took
ghost -5". It already knows who is in a group, and ghost display names live in
the encrypted `member.ghost_added`, so what it gains is a negative integer with
nobody attached. Small, but a move in the wrong direction, and recorded here so
it is not mistaken for free.

### What claiming once means

The first join naming a member id wins; a link used twice is invalid for the
second person. Otherwise they would silently displace the first, who would be
left a member with no history and no indication why.

Recovery chains still work (`2 → 3`, then `3 → 4`): a claim *target* is not
itself a claimed id, so being ghosted and re-invited a second time is fine.

### What it does not protect against

Claiming a ghost who is owed money is still appropriating a credit, and nothing
here prevents it. What guards that is the log — every claim is visible in the
clear — and the fact that you are publicly asserting you are that person.

### No corrective path

If someone joins on a plain link and should have taken over a ghost, there is
no merge button to fix it afterwards. The fix is to ghost them and re-invite
with the right link. Clunkier, but it is the same path recovery already uses,
and one mechanism that is occasionally awkward beats two that overlap.

## Events

```
member.added       { user_id, display_name, claims }  server-written, in the clear
member.ghost_added { member_id, display_name }   any member may add
member.left        { member_id }                 any member may ghost any member
group.revived_from { group_id, at_event_id }     first event of a revived group
```

`group.revived_from` is written only by the reviver, into the new group. It is
what lets the client hide the group that was left behind, and it records where
a ledger that appears from nowhere actually came from.

Everything except `member.added` is encrypted like any other payload.
`member.added` is the exception because the server writes it — which is what
lets `claims` be enforced rather than merely agreed.

## Deliberately not doing

- **Archiving** — staying in a group but hiding it from the default view. Wanted
  eventually; leaving is the destructive version and is what people ask for
  first.
- **Group key rotation on leave.** Consistent with member removal generally, and
  the reason leaving is presented as tidying rather than security.
- **Restricting who may ghost whom.** Account recovery requires a third party to
  act on behalf of someone who cannot act at all.
- **Carrying receipts through a revive.** They are content-addressed, sealed
  under the old group key and keyed `(group_id, id)`, so cloning means
  re-encrypting and re-uploading every one. Deliberately unresolved. The revive
  screen must say receipts are staying behind rather than let them disappear
  quietly, and the old membership row is kept precisely so the decision stays
  open.
