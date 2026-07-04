# Passkey authentication design

Date: 2026-07-03
Status: implemented on branch `feat/passkey-auth`, pending PR review

## Goal

Let team members sign in with a passkey (Face ID, Touch ID, Windows Hello, or a
hardware key) instead of typing a password, and let signed-in users register
and manage their passkeys. Passwords and Google sign-in remain available and
unchanged.

## Background

Supabase Auth shipped passkey support in beta (May 2026). GoTrue exposes
first-class passkey endpoints under `/auth/v1/passkeys/*`:

- `POST /passkeys/registration/options` (authenticated) returns
  `{ challenge_id, options, expires_at }` where `options` is a WebAuthn
  `PublicKeyCredentialCreationOptions` JSON object.
- `POST /passkeys/registration/verify` (authenticated) takes
  `{ challenge_id, credential }` and stores the passkey.
- `POST /passkeys/authentication/options` (public) returns
  `{ challenge_id, options }` for a discoverable-credential sign-in.
- `POST /passkeys/authentication/verify` (public) takes
  `{ challenge_id, credential }` and returns the same session payload as the
  password grant (`access_token`, `refresh_token`, `user`).
- `GET /passkeys`, `PATCH /passkeys/{id}`, `DELETE /passkeys/{id}`
  (authenticated) manage stored passkeys.

The feature is enabled per project via the management API or dashboard:
`passkey_enabled`, `webauthn_rp_id`, `webauthn_rp_display_name`,
`webauthn_rp_origins`.

## Key constraint: one domain only

Passkeys are cryptographically bound to a single Relying Party ID. This app has
four production URLs across `workers.dev` and `vercel.app`, plus localhost dev.
Only origins under the RP ID domain can register or use passkeys.

Decision: bind passkeys to the team's primary URL,
`ultimate-frisbee-warrior-tracker.ericxvoong.workers.dev`. The other
deployments and localhost keep password and Google sign-in; passkey UI is
hidden there. Changing this later means existing passkeys stop working, so if
the team ever moves to a custom domain, passkeys must be re-registered.

The bound host lives in one frontend constant, `PASSKEY_HOST` in
`frontend/lib/passkeys.ts`, which must match `webauthn_rp_id` in the Supabase
config.

## Approaches considered

1. Gateway-proxied passkeys (chosen). The BFF gateway proxies the GoTrue
   passkey endpoints; the browser only runs the WebAuthn ceremony
   (`navigator.credentials.create` / `.get`) and never sees tokens. Sessions
   stay in httpOnly cookies. No new dependencies: the WebAuthn JSON
   conversion uses the native `PublicKeyCredential.parseCreationOptionsFromJSON`,
   `parseRequestOptionsFromJSON`, and `toJSON` APIs (Chrome 118+, Safari 17.4+,
   Firefox 119+); the UI is hidden by feature detection elsewhere.
2. Use supabase-js's experimental passkey API in the browser. Rejected: it
   talks to GoTrue directly with real tokens in JS, which breaks the httpOnly
   cookie invariant that the whole gateway exists to protect.
3. Wait for the feature to leave beta. Rejected: the user asked for it now.
   The beta risk is contained in the gateway proxy layer and one client
   module, so an upstream API change is a small, local fix.

## Design

### Gateway (`gateway/auth-handlers.ts`)

New routes mirroring the upstream paths, all under the existing CSRF and
cookie machinery:

- `POST /auth/passkeys/registration/options` and
  `POST /auth/passkeys/registration/verify`: resolve the caller's access token
  from cookies (refreshing if needed), 401 if absent, then proxy to GoTrue
  with the token attached. Responses pass through, plus any rotated session
  cookies.
- `POST /auth/passkeys/authentication/options`: public proxy.
- `POST /auth/passkeys/authentication/verify`: public proxy; on success the
  gateway converts the returned session into httpOnly session cookies (same
  `sessionCookies()` helper as password login) and returns only
  `{ user: { id, email } }` to the browser.
- `GET /auth/passkeys`: authenticated proxy, lists the user's passkeys.
- `DELETE /auth/passkeys/{id}`: authenticated proxy, deletes one passkey. The
  id is validated as a UUID before being interpolated into the upstream path.

Security notes: registration requires an authenticated (and therefore
allowlist-checked at RLS level) session. Passkey sign-in issues tokens only
for existing confirmed users, and `/auth/session` still reports the
`is_allowed()` result, so the allowlist model is unchanged. No tokens ever
reach the browser.

### Frontend

- `frontend/lib/passkeys.ts`: `PASSKEY_HOST` constant plus
  `passkeysAvailable()` (host matches and the browser has the WebAuthn JSON
  APIs). All passkey UI is gated on this, so other deployments render exactly
  as before.
- `frontend/lib/authClient.ts`: `signInWithPasskey()`, `registerPasskey()`,
  `listPasskeys()`, `deletePasskey(id)`. Each wraps the two-step
  options/ceremony/verify dance.
- `frontend/contexts/AuthContext.tsx`: `loginWithPasskey()` that calls the
  client then refreshes session state, mirroring `login()`.
- `frontend/pages/Login.tsx`: a "Sign in with a passkey" button next to the
  Google button, only when `passkeysAvailable()`. A cancelled ceremony
  (NotAllowedError) is not shown as an error.
- `frontend/components/PasskeysDialog.tsx`: dialog listing the user's
  passkeys (name, created date) with add and delete actions. Reached from a
  "Passkeys" entry beside logout in both shells (desktop sidebar footer in
  `AppSidebar.tsx`, mobile header in `App.tsx`), rendered only when
  `passkeysAvailable()`.

### Supabase configuration

Via the management API (`PATCH /v1/projects/{ref}/config/auth`):

- `passkey_enabled`: true
- `webauthn_rp_id`: `ultimate-frisbee-warrior-tracker.ericxvoong.workers.dev`
- `webauthn_rp_display_name`: `Warrior Tracker`
- `webauthn_rp_origins`:
  `https://ultimate-frisbee-warrior-tracker.ericxvoong.workers.dev`

### Error handling

- Gateway: upstream GoTrue errors map through the existing
  `authErrorMessage()` so the browser sees a clean `{ error }` message.
- Client: user-cancelled or timed-out ceremonies surface as a quiet no-op on
  the login page and a dismissable message in the dialog. A
  `webauthn_credential_exists` error is translated to a friendly "this device
  already has a passkey for your account" message.

### Testing

- `npm test` (DB smoke tests) still passes; it does not cover the gateway.
- Manual verification: gateway routes exercised with curl (401 without a
  session, options payload shape with one). The WebAuthn ceremony itself can
  only be verified on the bound production domain after deploy, since
  localhost is not an allowed origin for the chosen RP ID.
- `cd frontend && npx tsc --noEmit` diffed against pre-existing errors.

## Out of scope

- Passkey rename (PATCH) UI. The list shows authenticator names; rename adds
  little for a small team.
- Making passkeys work on more than one deployment domain (impossible with a
  single Supabase RP ID).
- Removing passwords. Passkeys are additive.
