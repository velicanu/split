# 13 — Receipt-scanning backends

All receipt scanning goes through a **scanner backend**: a service that takes an
image and returns the line items and totals. The browser calls it over one fixed
contract; the app never talks to an LLM provider directly.

Today it does the opposite — the browser calls OpenAI or Anthropic straight,
with a per-device provider key (`pwa/src/ai.js`, `pwa/src/aikeys.js`). **That
direct path is removed when this plan is implemented**, not kept alongside. The
reasons it goes rather than staying as an option:

- **Sharing needs revocation, and a raw provider key can't give it.** A group
  scanner means one member sets it up and everyone scans. With a shared provider
  key, "revoke" can only mean rotating the one key at the provider — all-or-
  nothing, killing every group and the setter's own use, and useless against a
  member who already copied it. Per-group revocation needs per-group
  credentials, which only a backend we define can mint. The direct path is
  structurally unable to offer the one property the feature exists for.
- **One code path.** Dropping it removes the provider registry, the per-provider
  request/response branches, and the per-provider key endpoints and columns
  (~340 lines of client provider plumbing plus its server side), leaving a
  single credential kind and a single call.
- **Uniform security.** Every scanner becomes a token against a backend that can
  revoke, so there is no "personal scanners can't be revoked" corner left.

## The fixed contract

There is one contract and backends conform to it — we do not adapt per endpoint.
That is what keeps a scanner's config down to a URL and a token: the request and
response shapes are constants, not configuration.

Bearer auth, because we are choosing and it is the simplest thing that works.

```
POST <url>/scan
Authorization: Bearer <token>
Content-Type: application/json
{ "image": "<base64 JPEG>" }

200 →
{ "items": [{ "name": "Burger", "price_cents": 1000 }, ...],
  "subtotal_cents": 3000,
  "tax_cents": 250,
  "tip_cents": 600,
  "total_cents": 3850 }
```

The response is exactly what the model is asked for today (`pwa/src/ai.js`, the
`RECEIPT_SCHEMA`), so `extractReceipt` keeps its signature and everything
downstream of it is unchanged — only its body changes from a provider call to
this one. The image is a downscaled JPEG, as `prepareImage` already produces.

Nothing here touches the Split backend. The scan request goes from the browser
straight to the scanner backend; Split relays only the sealed config below and
never sees the token or the image — the same blindness it has for everything
else ([05](05-backend-relay.md), [06](06-e2e-encryption.md)).

## Two scopes: personal and group

A **personal scanner** is a member's own backend token, held the way a provider
key is today: sealed to their account and each of their devices, opened only
on-device, never readable by the Split server (reuse `pwa/src/aikeys.js`, minus
everything provider-specific). Only that member uses it. The token is a
credential with the scanner backend, not with an LLM provider — that is the only
change from today's storage.

A **group scanner** is one shared configuration a whole group can scan with. It
is the point of this document, and its security rests on one decision:

### The group holds a group-scoped credential, never a personal token

When a member enables their scanner for a group, the backend mints a credential
**bound to that group**, and *that* is what the group holds — not the member's
personal token, which never leaves their device.

The alternative — sealing the member's own token into the group — was rejected.
Any member can read a sealed group value (they hold the group key, and we do not
rotate it — [12](12-membership.md)), so a shared personal token could be used
for the setter's *other* groups too, and revoking one group would not stop it.
A group-scoped credential has neither problem: extracting it grants only what a
member of that group already has — scanning for that group — and revoking the
group invalidates exactly it.

This is what makes revocation real, and it is the reason the whole feature is a
backend rather than a shared key.

### The contract is also the licence boundary

The scanner backend lives in a **separate repo** and shares only the HTTP+JSON
contract above with this one. That is deliberate on three axes at once, and they
line up rather than fight:

- **Licence.** This repo is AGPL. AGPL copyleft reaches works *combined into* the
  program (shared code, linking, one process); it does not reach an independent
  program that merely talks to it over a network protocol — the FSF's settled
  position, and AGPL's section 13 network clause is about the AGPL'd work being
  served over a network, not about anything it calls. So a backend that (1) is a
  separate repo, (2) shares only the contract, and (3) copies no AGPL code, is a
  separate work. We and any self-hoster may licence it however we like — closed,
  permissive, proprietary model behind it — and keep its source private. The app
  stays AGPL and keeps its guarantees; the AI service is unencumbered.
- **Trust.** The Split relay stays end-to-end blind; the scanner is a distinct
  trust domain a group opts into, like choosing a provider today.
- **Revocation.** The per-group credential boundary above.

The same seam carries all three, which is the usual sign it is drawn in the
right place. Two conditions keep the licence separation clean: **do not copy
AGPL code across it** (a shared validator must be its own permissively-licensed
package, not lifted from this repo), and it must be a genuine independent service
— which a receipt scanner with standalone utility is, not a contrivance. This is
not legal advice; a real licence decision wants a lawyer, but the boundary is the
ordinary microservice kind.

### Revocation lives at the backend, not in the ledger

Each member configures a scanner **on their account** and sees the list of
groups it is enabled for. Revoking a group is a direct call to the backend that
invalidates that group's credential; the backend enforces it. It needs no ledger
event and no cooperation from the group.

Because enforcement is at the backend, **ghosting does not touch scanning**. An
earlier draft tied a shared scanner to its setter and deactivated it when the
setter was ghosted; that machinery existed only to compensate for a credential
that could not be un-shared. A backend that can revoke removes the need for it
entirely. If a ghosted setter wants to cut a group off, they revoke it, the same
way anyone does.

## The backend contract

Four verbs. The first, third and fourth are the member's account talking to the
backend with their personal token; only `scan` uses the group credential.

```
enable(group_ref) -> { url, group_token }   mint/return this group's credential
revoke(group_ref)                           invalidate it
groups() -> [group_ref, ...]                what this token is enabled for
scan(image, group_token) -> receipt         the fixed contract above
```

`group_ref` is an opaque id the client chooses per group; it must not leak
anything (a random per-group value, not the Split group id, so the backend never
learns Split's identifiers). The backend maps `(personal token, group_ref) ->
group_token` and enforces it.

## In the ledger

One current value per group, latest-wins, no author rule:

```
scanner.set     { enc: seal(groupKey, { url, group_token }) }
scanner.cleared { }
```

Anyone with an available scanner may `set`; anyone may `cleared`. Sealed under
the group key like every payload, so any member can open it and scan, and the
Split server cannot.

**"Unset" is two different acts, and the UI must not conflate them.** A member
clearing the group config removes it from the log, so in-app scanning stops for
everyone — but it does not revoke anything at the backend, because that needs the
setter's personal token. Only the setter, from their settings, truly cuts the
credential off. The clear dialog for a non-setter should say scanning is turned
off for the group, not that access was revoked.

## Choosing which scanner runs

A member with both a personal scanner and a group scanner available has a
**per-account setting** for which is the default — their own credential/spend, or
the group's. Absent the setting, group is the default (the shared one is the
reason most people will have scanning at all). A member with only one available
uses that one; a member with none sees no scan button, exactly as today.

The setting lives with the personal scanner config (account-sealed), because it
is only meaningful to someone who has a personal scanner to prefer.

## Honest limits

- **The scanner backend sees every receipt image any member scans** — a third
  party with group-wide reach. This is the same category of exposure as sending
  the image to OpenAI today, now on the group's behalf rather than one person's.
  The enable dialog says so in a line.
- **A group credential, once handed out, is readable by every current member**
  (group key, no rotation). Revoking the group is what cuts it off; until then,
  a member who extracted it can scan for that group outside the app. That is a
  strictly smaller blast radius than a shared personal token, which is why the
  group-scoped credential is the whole point — but it is not zero, and revoke is
  the control, not secrecy.

## What implementing this removes

Not additive — the direct-provider path is deleted, not left as a fallback:

- `pwa/src/ai.js` loses the per-provider request/response branches (the
  Anthropic and OpenAI calls) and the `PROVIDERS` registry; `extractReceipt`
  keeps its name and shape but calls the `/scan` contract.
- `pwa/src/aikeys.js` keeps the sealing machinery but loses everything keyed by
  provider — a scanner is one token, not a per-provider map.
- The server's per-provider AI endpoints and columns
  (`ai/providers/{provider}/…`, the provider/model settings) collapse to a
  single scanner config per account.

WIP data is disposable and the schema resets on deploy, so this is a straight
removal with no migration.

## Deliberately not doing

- **Per-member metering or attribution** inside a group. The backend sees one
  group credential, not who scanned. If a backend wants per-member limits it can
  mint per-member group credentials later; the ledger event carries whatever the
  `enable` call returned, so this is a backend change, not a client one.
- **Adapting to arbitrary third-party inference APIs.** The contract is fixed;
  a backend conforms or is not usable. Adapters are a maintenance surface we are
  choosing not to open.
- **A first-party hosted backend, decided here.** Whether the project runs a
  turnkey scanner or leaves everyone to bring their own is an operational and
  cost question, out of scope for this design — which only fixes the contract so
  either works. Someone must run *a* conforming backend for scanning to exist;
  that is the one hard dependency this creates.
- **Routing scans through the Split backend.** Its non-involvement is the
  property worth protecting; the scanner backend is a separate trust domain the
  group opts into.
