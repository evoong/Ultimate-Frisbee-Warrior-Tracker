# Passkey Platform Authenticator Steering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make passkey registration and sign-in prompt the device's own biometrics (Face ID, Touch ID, Windows Hello, Android fingerprint) instead of defaulting to the cross-device QR flow.

**Architecture:** A single pure function in `frontend/lib/passkeys.ts` augments the WebAuthn options JSON that Supabase returns, adding `hints: ["client-device"]` to both ceremonies and `authenticatorSelection.authenticatorAttachment: "platform"` to registration only. `createCredential` and `getCredential` pass options through it before the native `parseCreationOptionsFromJSON` / `parseRequestOptionsFromJSON` calls. Nothing else changes: not the gateway proxy, Supabase configuration, `authClient.ts`, `AuthContext.tsx`, the Login page, or `PasskeysDialog`.

**Tech Stack:** TypeScript, native WebAuthn JSON APIs, tsx (already a root dependency) for a dependency-free verification script.

Spec: `docs/superpowers/specs/2026-07-03-passkey-platform-authenticator-design.md`

## Global Constraints

- Documents and comments must never contain em dashes or emojis (CLAUDE.md rule).
- Never push to `main`; all commits go on the existing branch `feat/passkey-platform-authenticator`.
- No new dependencies. The frontend has no unit test framework; do not add one. Verification uses a throwaway tsx script plus typecheck and build, per the spec's Testing section.
- No Co-Authored-By lines or AI attribution in commit messages.
- `frontend/pages/*` has pre-existing type errors. A non-empty `tsc --noEmit` output is only a failure if it mentions `lib/passkeys.ts`.
- CLAUDE.md is gitignored in this checkout. Update it locally but never `git add` it.

---

### Task 1: Steering helper wired into both ceremonies

**Files:**
- Modify: `frontend/lib/passkeys.ts` (functions `createCredential` at lines 34-42 and `getCredential` at lines 44-52)
- Test: `/private/tmp/claude-501/-Users-lrubino-Documents-Automations-ultimate-frisbee-tracker-Ultimate-Frisbee-Warrior-Tracker/e5acd2bf-a3ff-44db-8d26-93281c46be6e/scratchpad/verify-steering.mts` (throwaway, never committed)

**Interfaces:**
- Consumes: the options JSON objects returned by `/auth/passkeys/registration/options` and `/auth/passkeys/authentication/options` (plain objects with `challenge`, `rpId` or `rp`, `timeout`, `userVerification`, and for registration possibly `authenticatorSelection`).
- Produces: `export function preferPlatformAuthenticator(options: unknown, ceremony: 'create' | 'get'): Record<string, unknown>`. Exported so the verification script can import it; `createCredential` and `getCredential` are its only production callers.

- [ ] **Step 1: Write the failing verification script**

Write the following to `<scratchpad>/verify-steering.mts` (use the absolute scratchpad path from Files above):

```ts
import assert from 'node:assert/strict'
import { preferPlatformAuthenticator } from '/Users/lrubino/Documents/Automations/ultimate-frisbee-tracker/Ultimate-Frisbee-Warrior-Tracker/frontend/lib/passkeys'

// Registration: adds hints and platform attachment, keeps existing fields.
const creation = preferPlatformAuthenticator(
  {
    challenge: 'abc',
    rp: { id: 'example.test' },
    user: { id: 'dXNlcg', name: 'u', displayName: 'u' },
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  },
  'create',
)
assert.deepEqual(creation.hints, ['client-device'])
assert.deepEqual(creation.authenticatorSelection, {
  residentKey: 'required',
  userVerification: 'preferred',
  authenticatorAttachment: 'platform',
})
assert.equal(creation.challenge, 'abc')
assert.deepEqual(creation.rp, { id: 'example.test' })

// Registration with no authenticatorSelection from the server still gets one.
const bare = preferPlatformAuthenticator({ challenge: 'abc' }, 'create')
assert.deepEqual(bare.authenticatorSelection, { authenticatorAttachment: 'platform' })

// Sign-in: adds hints only, no authenticatorSelection.
const request = preferPlatformAuthenticator(
  { challenge: 'xyz', rpId: 'example.test', userVerification: 'preferred' },
  'get',
)
assert.deepEqual(request.hints, ['client-device'])
assert.equal('authenticatorSelection' in request, false)
assert.equal(request.rpId, 'example.test')

// Input object is not mutated.
const input = { challenge: 'q' }
preferPlatformAuthenticator(input, 'create')
assert.deepEqual(input, { challenge: 'q' })

console.log('steering ok')
```

- [ ] **Step 2: Run it to verify it fails**

Run from the repo root:

```bash
npx tsx <scratchpad>/verify-steering.mts
```

Expected: FAIL with an error like `The requested module ... does not provide an export named 'preferPlatformAuthenticator'`.

- [ ] **Step 3: Implement the helper and wire it in**

In `frontend/lib/passkeys.ts`, insert this exported function directly above `createCredential`:

```ts
// Steer both ceremonies toward the device's own authenticator (Face ID,
// Touch ID, fingerprint) instead of the cross-device QR flow. Browsers must
// ignore unknown WebAuthn dictionary members, so adding "hints" is safe on
// browsers that predate it, and Safari already prefers the platform
// authenticator natively. Cross-device sign-in stays reachable behind the
// browser's "more options" fallback.
export function preferPlatformAuthenticator(
  options: unknown,
  ceremony: 'create' | 'get',
): Record<string, unknown> {
  const base = (options ?? {}) as Record<string, unknown>
  const steered: Record<string, unknown> = { ...base, hints: ['client-device'] }
  if (ceremony === 'create') {
    steered.authenticatorSelection = {
      ...(base.authenticatorSelection as Record<string, unknown> | undefined),
      authenticatorAttachment: 'platform',
    }
  }
  return steered
}
```

Then change the two parse calls to pass through it. In `createCredential`:

```ts
  const credential = await navigator.credentials.create({
    publicKey: statics.parseCreationOptionsFromJSON(preferPlatformAuthenticator(options, 'create')),
  })
```

In `getCredential`:

```ts
  const credential = await navigator.credentials.get({
    publicKey: statics.parseRequestOptionsFromJSON(preferPlatformAuthenticator(options, 'get')),
  })
```

No other lines in the file change.

- [ ] **Step 4: Run the verification script to verify it passes**

```bash
npx tsx <scratchpad>/verify-steering.mts
```

Expected: `steering ok`

- [ ] **Step 5: Typecheck the frontend**

```bash
cd frontend && npx tsc --noEmit; cd ..
```

Expected: any errors mention only pre-existing `pages/*` files. Zero errors mentioning `lib/passkeys.ts`.

- [ ] **Step 6: Commit**

```bash
git add frontend/lib/passkeys.ts
git commit -m "Steer passkey ceremonies to the platform authenticator"
```

Do not commit the scratchpad script.

---

### Task 2: Build verification and CLAUDE.md update

**Files:**
- Modify: `CLAUDE.md` (Passkeys section; gitignored, local-only, never staged)

**Interfaces:**
- Consumes: `preferPlatformAuthenticator` from Task 1 (documentation only).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Production build**

```bash
npm run build
```

Expected: Vite build completes with exit code 0 (warnings acceptable).

- [ ] **Step 2: Update the Passkeys section of CLAUDE.md**

Append this paragraph to the existing Passkeys section (plain prose, no em dashes):

```markdown
Both ceremonies are steered toward the device's own authenticator:
`preferPlatformAuthenticator` in `frontend/lib/passkeys.ts` adds
`hints: ["client-device"]` to registration and sign-in options, and forces
`authenticatorSelection.authenticatorAttachment: "platform"` at registration
so new passkeys are created on the device in use rather than via the QR
cross-device flow. QR sign-in remains available behind the browser's "more
options" fallback. Hardware security keys cannot be registered while the
platform attachment is forced.
```

Do not stage CLAUDE.md; it is gitignored in this checkout.

- [ ] **Step 3: Confirm the working tree is clean apart from CLAUDE.md**

```bash
git status --short
```

Expected: nothing staged; only the gitignored CLAUDE.md change exists locally (it will not appear in the output at all since ignored files are hidden).

---

### Post-merge manual verification (human step, after deploy)

Not a plan task, but required by the spec before calling this done. After the PR merges and Workers Builds deploys `main`:

1. On `ultimate-frisbee-warrior-tracker.ericxvoong.workers.dev`, open the passkeys dialog and register a new passkey. Expected: a direct Touch ID, Face ID, or fingerprint prompt, with no QR screen.
2. Sign out, then use "Sign in with a passkey". Expected: the local biometric prompt appears first; QR is only reachable under the browser's "more options".
3. An existing phone-held passkey still signs in via the cross-device fallback.
