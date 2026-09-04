import { decodeJwtPayload, mapVerifiedClaims } from './jwt.ts'

let failed = 0
function check(name, cond) {
  console.log(`${cond ? '✓' : '✗'}  ${name}`)
  if (!cond) failed++
}

// A payload shaped like Supabase's anonymous session: sub present, no email.
const anonPayload = Buffer.from(JSON.stringify({
  sub: '11111111-1111-1111-1111-111111111111',
  is_anonymous: true,
  exp: Math.floor(Date.now() / 1000) + 3600,
})).toString('base64url')
const token = `x.${anonPayload}.y`

const decoded = decodeJwtPayload(token)
check('decodes an anonymous payload', decoded?.sub?.startsWith('1111'))
check('surfaces is_anonymous', decoded?.is_anonymous === true)

// --- mapVerifiedClaims: the mapping this task actually changes ---

// A real anonymous session payload shape (as minted by the local Supabase
// stack): email is the empty string, not absent.
const realAnonPayload = {
  sub: '11111111-1111-1111-1111-111111111111',
  aud: 'authenticated',
  email: '',
  phone: '',
  role: 'authenticated',
  is_anonymous: true,
  amr: [{ method: 'anonymous' }],
}
check(
  'real anonymous payload maps to null email, isAnonymous true',
  JSON.stringify(mapVerifiedClaims(realAnonPayload)) ===
    JSON.stringify({ sub: '11111111-1111-1111-1111-111111111111', email: null, isAnonymous: true })
)

// A real signed-in session payload.
const realSignedInPayload = {
  sub: '22222222-2222-2222-2222-222222222222',
  aud: 'authenticated',
  email: 'captain@local.test',
  role: 'authenticated',
  is_anonymous: false,
}
check(
  'real signed-in payload maps to its email, isAnonymous false',
  JSON.stringify(mapVerifiedClaims(realSignedInPayload)) ===
    JSON.stringify({ sub: '22222222-2222-2222-2222-222222222222', email: 'captain@local.test', isAnonymous: false })
)

// No sub at all -> reject.
check(
  'payload with no sub maps to null',
  mapVerifiedClaims({ email: 'x@example.com', is_anonymous: false }) === null
)

// Non-anonymous with an empty email -> malformed, not a guest -> reject.
check(
  'non-anonymous payload with empty email maps to null',
  mapVerifiedClaims({ sub: '33333333-3333-3333-3333-333333333333', email: '', is_anonymous: false }) === null
)

// Non-anonymous with a whitespace-only email -> malformed, not a guest -> reject.
check(
  'non-anonymous payload with whitespace-only email maps to null',
  mapVerifiedClaims({ sub: '44444444-4444-4444-4444-444444444444', email: '   ', is_anonymous: false }) === null
)

process.exit(failed ? 1 : 0)
