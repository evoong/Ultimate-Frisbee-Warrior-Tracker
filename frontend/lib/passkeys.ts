// Passkeys are cryptographically bound to a single WebAuthn Relying Party ID,
// configured in Supabase (Authentication, Passkeys). This constant must match
// that RP ID: passkey UI is only shown on the one deployment it covers, since
// the browser rejects ceremonies from any other origin.
export const PASSKEY_HOST = 'ultimate-frisbee-warrior-tracker.ericxvoong.workers.dev'

// The native WebAuthn JSON helpers (Chrome 118+, Safari 17.4+, Firefox 119+).
// Older lib.dom typings may not know them, hence the loose typing.
interface PublicKeyCredentialStatics {
  parseCreationOptionsFromJSON?: (json: unknown) => PublicKeyCredentialCreationOptions
  parseRequestOptionsFromJSON?: (json: unknown) => PublicKeyCredentialRequestOptions
}

function credentialStatics(): PublicKeyCredentialStatics | null {
  if (typeof PublicKeyCredential === 'undefined') return null
  return PublicKeyCredential as unknown as PublicKeyCredentialStatics
}

export function passkeysAvailable(): boolean {
  const statics = credentialStatics()
  return (
    window.location.hostname === PASSKEY_HOST &&
    !!statics?.parseCreationOptionsFromJSON &&
    !!statics?.parseRequestOptionsFromJSON
  )
}

// True when the user dismissed or timed out the browser's passkey prompt,
// which callers should treat as a quiet cancel rather than an error.
export function isCeremonyCancelled(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'NotAllowedError'
}

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

export async function createCredential(options: unknown): Promise<unknown> {
  const statics = credentialStatics()
  if (!statics?.parseCreationOptionsFromJSON) throw new Error('Passkeys are not supported here')
  const credential = await navigator.credentials.create({
    publicKey: statics.parseCreationOptionsFromJSON(preferPlatformAuthenticator(options, 'create')),
  })
  if (!credential) throw new Error('No credential returned')
  return (credential as unknown as { toJSON: () => unknown }).toJSON()
}

export async function getCredential(options: unknown): Promise<unknown> {
  const statics = credentialStatics()
  if (!statics?.parseRequestOptionsFromJSON) throw new Error('Passkeys are not supported here')
  const credential = await navigator.credentials.get({
    publicKey: statics.parseRequestOptionsFromJSON(preferPlatformAuthenticator(options, 'get')),
  })
  if (!credential) throw new Error('No credential returned')
  return (credential as unknown as { toJSON: () => unknown }).toJSON()
}
