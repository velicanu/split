import hashlib
import os
import sqlite3
from contextlib import contextmanager

DB_PATH = os.environ.get("DB_PATH", "split.db")


def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


@contextmanager
def db():
    """A connection scoped to one request: one transaction, then closed.

    - **Foreign keys on.** SQLite leaves them off by default, which made every
      `REFERENCES` clause decorative; enabling it makes the schema's integrity
      real. Set before the transaction opens, since the pragma is a no-op inside
      one.
    - **WAL**, so a reader never blocks the writer.
    - **Closed on exit.** The bare `sqlite3.connect` this replaced was only ever
      committed (via `with conn`), never closed, so every request leaked a
      connection object until GC reclaimed it.

    `init_db` deliberately does NOT use this — its table drops must run with FK
    off (see there)."""
    conn = connect()
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    try:
        with conn:
            yield conn
    finally:
        conn.close()


# Bump whenever the schema changes shape. See reset_if_stale below: while we
# are still in development this triggers a wipe, not a migration.
SCHEMA_VERSION = 11


def reset_if_stale(conn):
    """Drop everything when the schema version moves.

    No migrations until development is finished — WIP data is disposable. The
    catch is that `CREATE TABLE IF NOT EXISTS` silently does nothing against an
    older table, so without this a deployed database keeps its old columns and
    the first INSERT fails at runtime. That is exactly what happened when
    PR A shipped: the release notes said the data was dropped, but nothing
    dropped it.

    DESTRUCTIVE, and deliberately so. Remove this before there is data anyone
    cares about, and write real migrations instead.
    """
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    if version != SCHEMA_VERSION:
        tables = conn.execute(
            "SELECT name FROM sqlite_master"
            " WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
        for (name,) in tables:
            conn.execute(f'DROP TABLE IF EXISTS "{name}"')
        conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")


def init_db():
    # DDL runs with foreign keys OFF (SQLite's default via connect(), not db()):
    # reset_if_stale drops every table, and dropping a parent while a child still
    # references it raises under FK enforcement. Runtime queries use db(), which
    # turns FK on.
    with connect() as conn:
        reset_if_stale(conn)
        # No password material here at all. The server authenticates a signature
        # from a registered device key, so it holds nothing that could be used
        # to impersonate a user or decrypt their data.
        #
        # login_handle is unique only so a device with no keys yet can find its
        # wrapped account key. display_name is what people actually see and is
        # deliberately NOT unique.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS users ("
            " id INTEGER PRIMARY KEY,"
            " login_handle TEXT UNIQUE NOT NULL,"
            " display_name TEXT NOT NULL,"
            " account_pubkey TEXT NOT NULL,"
            # X25519, so group keys can be sealed to the account for the
            # no-live-device enrolment path. Distinct from account_pubkey,
            # which is Ed25519 and only ever signs.
            " account_box_pubkey TEXT NOT NULL)"
        )
        # The account private key, encrypted client-side under some unlock
        # secret. Opaque here. There can be several: a password, a recovery code,
        # and one per passkey — each an independent wrap of the *same* account
        # key, so any one of them can bootstrap a fresh device. Keyed by a
        # client-chosen id ('password', 'recovery', or a passkey's own id) so a
        # password change replaces just its row and a passkey adds one, rather
        # than every method sharing a single slot. `method` is for display and
        # for a new device to know how to satisfy the wrap. See plan/16.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS key_wraps ("
            " user_id INTEGER NOT NULL REFERENCES users(id),"
            " id TEXT NOT NULL,"
            " method TEXT NOT NULL,"
            " params TEXT NOT NULL,"
            " ciphertext TEXT NOT NULL,"
            " PRIMARY KEY (user_id, id))"
        )
        # One row per device. Revoking — and logging out, which is the same
        # act — deletes the row: the device can no longer authenticate, and
        # because it only ever held its own key it cannot enrol a replacement
        # either. Deleted rather than tombstoned, so nobody accumulates a list
        # of every browser they have ever signed out of.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS devices ("
            " id TEXT PRIMARY KEY,"
            " user_id INTEGER NOT NULL REFERENCES users(id),"
            " pubkey TEXT UNIQUE NOT NULL,"
            " box_pubkey TEXT NOT NULL,"
            " label TEXT NOT NULL,"
            " created_at TEXT NOT NULL DEFAULT (datetime('now')))"
        )
        # A group's symmetric key, sealed to one recipient. The server relays
        # these without being able to open any of them: sealing is anonymous
        # X25519, so only the holder of the matching secret key can read one.
        # Rows are always self-authored — you seal the key you already have to
        # your own account and devices. Nobody wraps a key for anyone else,
        # because an invite link carries it in the URL fragment instead.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS group_keys ("
            " group_id INTEGER NOT NULL REFERENCES groups(id),"
            " recipient_kind TEXT NOT NULL,"
            " recipient_id TEXT NOT NULL,"
            " ciphertext TEXT NOT NULL,"
            " PRIMARY KEY (group_id, recipient_kind, recipient_id))"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS challenges ("
            " nonce TEXT PRIMARY KEY,"
            " pubkey TEXT NOT NULL,"
            " expires_at REAL NOT NULL)"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS sessions ("
            " token TEXT PRIMARY KEY,"
            " user_id INTEGER NOT NULL REFERENCES users(id),"
            " device_id TEXT NOT NULL REFERENCES devices(id))"
        )
        conn.execute(
            # `read_token`, when set, is an opt-in read-only capability: anyone
            # presenting it (no account, no membership) can fetch the encrypted
            # feed and decrypt it with the group key from the share link. Off by
            # default — sharing read to non-members is more public than an
            # invite, so it is a deliberate switch. Clearing or rotating it
            # revokes future fetches (not the key, which we never rotate).
            "CREATE TABLE IF NOT EXISTS groups ("
            " id INTEGER PRIMARY KEY,"
            " name TEXT NOT NULL,"
            " code TEXT UNIQUE NOT NULL,"
            " read_token TEXT,"
            " created_by INTEGER NOT NULL REFERENCES users(id))"
        )
        # `until_event_id` is what makes ghosting a fork rather than a race.
        # A ghosted member keeps their membership and keeps being served the
        # group — capped at the event that ghosted them. The cut is a position
        # in the log, so it does not matter whether they sync a second later or
        # a year later: they see exactly the prefix, deterministically.
        #
        # `hidden` is set when someone revives out of a group: the row stays,
        # so their receipts and the frozen prefix remain reachable, but the
        # group stops appearing in their list. A view preference rather than a
        # secret — the server already knows who is in what.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS memberships ("
            " group_id INTEGER NOT NULL REFERENCES groups(id),"
            " user_id INTEGER NOT NULL REFERENCES users(id),"
            " until_event_id INTEGER,"
            " hidden INTEGER NOT NULL DEFAULT 0,"
            " PRIMARY KEY (group_id, user_id))"
        )
        # Append-only per-group event log. `id` is a global monotonic sequence
        # that doubles as the sync cursor / group version. The server stores
        # payloads opaquely and never computes on them — clients fold the log.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS events ("
            " id INTEGER PRIMARY KEY,"
            " group_id INTEGER NOT NULL REFERENCES groups(id),"
            " event_id TEXT UNIQUE NOT NULL,"
            " type TEXT NOT NULL,"
            " payload TEXT NOT NULL,"
            " author INTEGER NOT NULL REFERENCES users(id),"
            " created_at TEXT NOT NULL DEFAULT (datetime('now')))"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS events_group_id ON events (group_id, id)"
        )
        # Per-user AI provider credentials. There is no built-in default
        # provider: with no rows the feature is simply unavailable. Adding a key
        # or explicitly switching sets active=1 (and clears the others), so the
        # latest add-or-select wins. Keys are stored in the clear for now.
        # Receipt images, encrypted client-side under the group key. The server
        # stores ciphertext and has no idea what any of it depicts — there is no
        # content type here because it cannot know one.
        #
        # `id` is the BLAKE2b-256 hash of the ciphertext, so storage is
        # content-addressed: the server cannot substitute one blob for another
        # without the client noticing, and a repeated upload is a no-op.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS receipts ("
            " group_id INTEGER NOT NULL REFERENCES groups(id),"
            " id TEXT NOT NULL,"
            " uploader INTEGER NOT NULL REFERENCES users(id),"
            " bytes BLOB NOT NULL,"
            " created_at TEXT NOT NULL DEFAULT (datetime('now')),"
            # Keyed by group as well as content: an id says what a blob *is*,
            # not who may read it. Two groups uploading identical bytes must
            # not end up sharing one row whose access is decided by whichever
            # got there first.
            " PRIMARY KEY (group_id, id))"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS ai_providers ("
            " user_id INTEGER NOT NULL REFERENCES users(id),"
            " provider TEXT NOT NULL,"
            " model TEXT NOT NULL,"
            " active INTEGER NOT NULL DEFAULT 0,"
            " PRIMARY KEY (user_id, provider))"
        )
        # The API key itself, sealed to one recipient. Same shape and same
        # reasoning as group_keys: the server relays copies it cannot open, and
        # accepts only rows you address to yourself.
        #
        # This is a live billable credential — the most immediately expensive
        # thing in the database — so it gets the same treatment as everything
        # else rather than being the one plaintext exception.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS ai_keys ("
            " user_id INTEGER NOT NULL REFERENCES users(id),"
            " provider TEXT NOT NULL,"
            " recipient_kind TEXT NOT NULL,"
            " recipient_id TEXT NOT NULL,"
            " ciphertext TEXT NOT NULL,"
            " PRIMARY KEY (user_id, provider, recipient_kind, recipient_id))"
        )
        # A standalone shared bill: one receipt, split by claiming, no accounts
        # for the people claiming. See plan/15.
        #
        # `snapshot` is the sealed static half — items, who paid, tax/tip/total,
        # receipt ids — set once by the authenticated creator and never changed.
        # The server stores it opaquely, exactly like an event payload. The bill
        # key that opens it rides in the link fragment and never reaches here.
        #
        # `token` is the bearer capability the link carries: presenting it (as a
        # header) lets anyone read the bill and join it. Checked with a
        # constant-time compare, like a group's read_token.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS bills ("
            " id TEXT PRIMARY KEY,"
            " token TEXT NOT NULL,"
            " snapshot TEXT NOT NULL,"
            " created_by INTEGER NOT NULL REFERENCES users(id),"
            " created_at TEXT NOT NULL DEFAULT (datetime('now')))"
        )
        # The mutable half: one row per participant. The creator seeds ghosts
        # (the diners they already know) with a name and no secret; a link-opener
        # then either binds a secret to a ghost (claiming it, first bind wins) or
        # inserts a new row for themselves. `name` and `claims` are sealed under
        # the bill key — the server never sees who anyone is or what they took.
        #
        # `secret` is the account-less stand-in for membership: minted by the
        # browser at join, it both makes claim-once enforceable (a ghost can be
        # bound once) and gates edits to that participant's own claims. It is a
        # bearer token the server compares, never user content. See plan/15.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS bill_participants ("
            " bill_id TEXT NOT NULL REFERENCES bills(id),"
            " participant_id INTEGER NOT NULL,"
            " name TEXT NOT NULL,"
            " claims TEXT,"
            " secret TEXT,"
            " PRIMARY KEY (bill_id, participant_id))"
        )
        # The receipt image, encrypted under the bill key. Same content-addressed
        # shape as group receipts (id is the BLAKE2b-256 of the ciphertext), but
        # keyed by bill and reachable with the bill token rather than a
        # membership, so account-less claimers can see the photo.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS bill_receipts ("
            " bill_id TEXT NOT NULL REFERENCES bills(id),"
            " id TEXT NOT NULL,"
            " bytes BLOB NOT NULL,"
            " PRIMARY KEY (bill_id, id))"
        )


MAX_RECEIPT_BYTES = 8 * 1024 * 1024


def content_id(raw: bytes) -> str:
    """BLAKE2b-256, matching libsodium's crypto_generichash at 32 bytes so the
    client and server agree on what a blob is called."""
    return hashlib.blake2b(raw, digest_size=32).hexdigest()
