from pydantic import BaseModel


class WrapIn(BaseModel):
    # A client-chosen id ('password', 'recovery', or a passkey's own id); the
    # method tells a fresh device how to satisfy it.
    id: str
    method: str
    params: str
    ciphertext: str


class SignupIn(BaseModel):
    login_handle: str
    display_name: str
    account_pubkey: str
    account_box_pubkey: str
    device_pubkey: str
    box_pubkey: str
    label: str = "this device"
    wraps: list[WrapIn] = []


class ChallengeIn(BaseModel):
    device_pubkey: str


class VerifyIn(BaseModel):
    device_pubkey: str
    nonce: str
    signature: str


class DeviceIn(BaseModel):
    pubkey: str
    box_pubkey: str
    label: str = "new device"
    # Who authorised this enrolment: a device that is already trusted, or the
    # account key (the no-live-device path). The signature is over the new
    # device's own public key, which binds the authorisation to this device.
    signed_by: str  # 'device' | 'account'
    signer_pubkey: str
    signature: str


class GroupCreate(BaseModel):
    name: str


class JoinGroup(BaseModel):
    code: str
    # The member id from the invite's `as=`, if it named one.
    claims: int | None = None


class ReadSharingIn(BaseModel):
    enabled: bool
    # Mint a fresh token even if one exists — revoke the old link, hand out a
    # new one — when re-enabling.
    rotate: bool = False


class EventIn(BaseModel):
    event_id: str
    type: str
    payload: dict = {}


# Cheapest vision-capable model per provider — the default when a key is added.
DEFAULT_MODELS = {"anthropic": "claude-haiku-4-5", "openai": "gpt-5.4-nano"}


class ReceiptIn(BaseModel):
    receipt_id: str
    ciphertext: str


class ProviderIn(BaseModel):
    # No api_key field: a plaintext key sent here would be silently ignored,
    # which is worse than refusing it. Keys arrive sealed, via /keys.
    model: str | None = None


class ActiveIn(BaseModel):
    provider: str


class BillParticipantIn(BaseModel):
    # A seeded ghost: a client-chosen id and a sealed name, no secret. Whoever
    # opens the link binds a secret to it later, or adds themselves instead.
    participant_id: int
    name: str


class BillReceiptIn(BaseModel):
    receipt_id: str
    ciphertext: str


class BillCreate(BaseModel):
    # The sealed static half, plus the diners the creator already knows.
    snapshot: str
    participants: list[BillParticipantIn] = []
    receipts: list[BillReceiptIn] = []


class BillJoinIn(BaseModel):
    # Adding yourself: a fresh id, a sealed name, and the secret that will own
    # your claims from here on.
    participant_id: int
    name: str
    secret: str


class BillClaimGhostIn(BaseModel):
    # Taking over a seeded ghost. The id is in the path; this binds the secret.
    secret: str


class BillClaimsIn(BaseModel):
    # Editing my own claims: the secret proves the row is mine, the sealed blob
    # is the new set of item ids.
    secret: str
    claims: str


class GhostIn(BaseModel):
    # The member being ghosted, and the event that records it. The event is
    # appended by the client (it is encrypted, so the server cannot write it);
    # this call is what freezes their feed at that point.
    member_id: int
    at_event_id: int


class GroupKeysIn(BaseModel):
    keys: list[dict]
