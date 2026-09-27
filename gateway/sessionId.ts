// Chat session ids stay client-minted (localStorage), but must be UUIDs.
// User scoping makes guessing someone else's id useless — this is format
// hygiene, not auth: it stops arbitrary strings reaching the session_id
// text column and retires the pre-2026 `s_<ts>_<rand>` format on the wire.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isValidSessionId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}
