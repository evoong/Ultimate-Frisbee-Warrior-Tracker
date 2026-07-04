# Passkey platform authenticator steering

Date: 2026-07-03
Status: Approved

## Problem

Passkey ceremonies (both registration and sign-in) present the browser's full
credential picker, which frequently steers users to the "scan this QR code
with your phone" cross-device flow instead of the device's own biometrics
(Face ID, Touch ID, Windows Hello, Android fingerprint).

Root cause: the WebAuthn options returned by Supabase are minimal. The live
authentication options contain only `challenge`, `timeout`, `rpId`, and
`userVerification`. Neither ceremony includes `hints` or an
`authenticatorSelection.authenticatorAttachment` preference, so the browser
has no signal to prefer the local platform authenticator.

This is worst at registration: if the passkey is created via the QR flow, the
credential lives on the phone, and every future sign-in on the original
device requires the phone again.

## Decision

Steer both ceremonies toward the platform authenticator client-side, in
`frontend/lib/passkeys.ts`, by augmenting the options JSON before it is
parsed and handed to the browser. This was chosen over a login-only hint
(does not fix the root cause at registration) and over conditional UI
passkey autofill (a larger Login page change with patchier browser support,
possible later enhancement).

Cross-device sign-in remains available as a deliberate fallback under the
browser's "more options" path. It is no longer the default.

## Changes

All changes are in `frontend/lib/passkeys.ts`. Nothing else changes: not the
gateway proxy, Supabase configuration, `authClient.ts`, `AuthContext.tsx`,
the Login page, or `PasskeysDialog`.

### createCredential (registration)

After receiving the server options and before
`PublicKeyCredential.parseCreationOptionsFromJSON`, merge into the plain
JSON object:

- `hints: ["client-device"]`
- `authenticatorSelection: { ...existing, authenticatorAttachment: "platform" }`

All fields supplied by Supabase (challenge, rp, user, pubKeyCredParams,
residentKey, userVerification, and so on) are preserved. Only the steering
fields are added, and any existing `authenticatorSelection` members are kept.

### getCredential (sign-in)

Same pattern, adding only `hints: ["client-device"]`. The request ceremony
has no `authenticatorSelection` field.

### Why mutate the JSON, not the parsed options

Mutating the plain JSON object before parsing avoids fighting the strict
`PublicKeyCredentialCreationOptions` lib.dom typings, and the WebAuthn spec
requires browsers to ignore unknown dictionary members, so browsers without
`hints` support (Safari) are unaffected. Safari already defaults to Touch ID
and Face ID natively.

## What this affects at runtime

- Registration: the browser prompts the device's own authenticator directly.
  No QR detour, so the passkey is created on the device in use.
- Sign-in: browsers that support hints (Chrome, Edge) list local passkeys and
  biometrics first. QR moves behind "more options".
- Verify payloads are unaffected: hints and attachment preferences influence
  browser UI only, not the credential format sent to
  `/auth/passkeys/*/verify`.

## Error handling

Unchanged. `isCeremonyCancelled` already treats a dismissed or timed-out
prompt (`NotAllowedError`) as a quiet cancel.

## Compatibility

- Existing passkeys registered via QR onto a phone keep working through the
  cross-device fallback.
- Users who want on-device biometrics on a given device re-register a passkey
  there (Supabase allows up to 10 passkeys per user, one per authenticator).
- Hardware security keys are excluded at registration by the `platform`
  attachment. This is acceptable for this team-only app; sign-in still
  accepts any existing credential.

## Testing

1. `cd frontend && npx tsc --noEmit`, diffing output against the touched
   file only (pre-existing unrelated errors exist in `frontend/pages/*`).
2. `npm run build` for a production build.
3. Manual verification on
   `ultimate-frisbee-warrior-tracker.ericxvoong.workers.dev`:
   - Register a new passkey: expect a direct Touch ID, Face ID, or
     fingerprint prompt with no QR screen.
   - Sign out, then sign in with passkey: expect the local biometric prompt
     first, with QR only under "more options".
