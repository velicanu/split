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

## Two kinds of link

A group has two ways in. They differ by one field.

**A group link** — `#join=<code>&gk=<key>` — names nobody. It is the same link
every time, it does not expire, and it is for pasting where a group of people
already talk. Whoever opens it is asked who they are before anything is
written; see *Choosing who you are* below.

**A member link** — `#join=<code>&gk=<key>&as=<member_id>` — says *who to
become*. Accepting it joins the group and claims that member in one act, so
there is no window in which someone else could claim the ghost first, and
nobody has to remember to do it afterwards. It is meant for one named person,
and a member can only be claimed once, so it works once.

Inviting a specific person always produces a member to become. If you are
inviting someone already in the split, it is their existing ghost; otherwise a
ghost is created for them there and then, which means the group can split with
them before they ever accept.

Both carry the group key in the fragment, so both are exactly as sensitive as
the group itself. The group link is the more dangerous of the two only because
it is *meant* to be pasted somewhere with an audience.

### Why not one link

An earlier version had only the member link, on the reasoning that a claim is
too important to leave to the person claiming. It turned the ordinary case —
*here is the flat group, everyone join* — into one hand-minted link per person,
which is not a thing anyone does in a group chat. The version before that had
only the group link, and left claiming to a `member.merged` event somebody had
to remember to write afterwards, which is the coordination problem this design
exists to remove.

Both links keep claiming inside the join. They differ only in who makes the
choice: the inviter, or the joiner.

## Choosing who you are

A group link names nobody, so the person opening it makes the choice the
inviter would otherwise have made — take over a member the group has been
splitting with, or arrive as somebody new.

That choice has to be made *before* the join, because claiming is part of the
join and there is no second chance at it. So the joiner has to see the ghost
names, and those are encrypted: the server cannot offer the list itself.

`GET /api/groups/preview?code=<code>` is what closes that. It returns the
member events, and only the member events, to anyone holding the join code; the
client decrypts them with the key from the link's fragment and folds them into
the same member list the group itself sees.

This gives away nothing that joining would not. The join code *is* the write
capability: whoever holds it can join and then read the whole feed. What keeps
it narrow is that it is both scoped and attributable — only `member.*` comes
back, so the code buys *who is in the split* rather than what they spent, and an
account is required, so a guessed code is not an anonymous window onto a group.

Only members with nobody attached are offered, which the fold already works out:
a claimed member is not a separate person in it. Someone who is already in the
group is sent straight there instead of being asked, because there is nothing
they could usefully answer — see below.

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

The first join naming a member id wins; a *member* link used twice is invalid
for the second person. Otherwise they would silently displace the first, who
would be left a member with no history and no indication why. A group link is
not used up by this — it names nobody, so there is nothing for a second opener
to find taken, only a shorter list to choose from.

A claim from somebody **already in the group** is refused outright (409) rather
than dropped. Claiming happens at the instant of joining and nowhere else, so a
claim from an existing member has no instant to happen at; letting the call
succeed anyway would tell them they had taken over a ghost and then show them
none of its history. Reachable in practice now that one link can be opened
twice — a second tab, or the back button.

Recovery chains still work (`2 → 3`, then `3 → 4`): a claim *target* is not
itself a claimed id, so being ghosted and re-invited a second time is fine.

### What it does not protect against

Claiming a ghost who is owed money is still appropriating a credit, and nothing
here prevents it. What guards that is the log — every claim is visible in the
clear — and the fact that you are publicly asserting you are that person.

### No corrective path

If someone joins as a new person and should have taken over a ghost, there is
no merge button to fix it afterwards. The fix is to ghost them and re-invite
with a member link. Clunkier, but it is the same path recovery already uses,
and one mechanism that is occasionally awkward beats two that overlap.

Being asked the question up front (*Choosing who you are*) makes the wrong
answer rarer without making it impossible — somebody will still tap past it.
Rarer is worth having; it is not a reason to add the second mechanism back.

## Changing a name

A display name is set at signup and was, for a while, permanent. It is now an
appended event like anything else — nothing is rewritten, and the fold takes
the latest rename an id was allowed to make, exactly as an edited expense is
the latest revision of itself.

```
member.renamed { member_id, display_name }
```

**Who may rename whom is a rule the fold can actually enforce**, which is rare
here. The server stamps `author` on every event and a client cannot forge it,
so:

- **An account may rename itself and nobody else.** Compared through `resolve`,
  so it reads "is this identity now me" rather than "is this literally my id" —
  which means you may also rename an identity you have claimed, since that is
  you as well.
- **Any member may rename a ghost.** A ghost has nobody to speak for them, and
  a typo would otherwise be permanent. Same reasoning that lets any member add
  a ghost, or ghost anyone.

Renames are applied in log order and a refused one is *skipped*, not merely
sorted behind — taking the latest and filtering afterwards would let anyone
blank out a rename they were not allowed to make. A blank name is ignored: it
would leave someone unnameable everywhere and there is no undo for an event.

### The name lives in two places

`users.display_name` on the server is what `add_member` stamps into the
`member.added` it writes, so it is the name a group you join **from now on**
will call you. Groups you are already in hold their own copy, in an event the
server can neither read nor write. So renaming is an API call *plus* a
`member.renamed` appended to each existing group.

Those can disagree in between, and the client says so rather than papering over
it — a group whose key this device does not hold cannot be told at all. The
alternative, a transaction across an encrypted log the server cannot write, is
not available at any price.

### What it does to history

Renaming a claimed ghost changes what old rows are shown to have been *written
under* (see below). Rename Sam to Samantha and history written under "Sam"
starts reading `(as Samantha)`.

Accepted deliberately. `formerly` answers *which identity is this row about*,
labelled with that identity's best-known name; making it point-in-time means
storing a name per row, which is a great deal of machinery for a caption.

## Events

```
member.added       { user_id, display_name, claims }  server-written, in the clear
member.ghost_added { member_id, display_name }   any member may add
member.left        { member_id }                 any member may ghost any member
member.renamed     { member_id, display_name }   yourself, or any ghost
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
