// Thin client for the gateway's /auth/* endpoints. Sessions live in
// httpOnly cookies, so this module never sees or stores a token.

import { createCredential, getCredential } from './passkeys'

export interface AuthUser {
  id: string
  email: string
}

export interface SessionInfo {
  user: AuthUser | null
  allowed: boolean
}

async function post(path: string, body?: unknown): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function readError(res: Response): Promise<string> {
  try {
    const data = await res.json()
    return data?.error || `request failed (${res.status})`
  } catch {
    return `request failed (${res.status})`
  }
}

export async function getSession(): Promise<SessionInfo> {
  const res = await fetch('/auth/session', { credentials: 'include' })
  if (!res.ok) return { user: null, allowed: false }
  const data = await res.json()
  return { user: data.user ?? null, allowed: data.allowed === true }
}

export async function login(email: string, password: string): Promise<AuthUser> {
  const res = await post('/auth/login', { email, password })
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()).user
}

export async function signup(
  email: string,
  password: string
): Promise<{ user: AuthUser | null; confirmationRequired: boolean }> {
  const res = await post('/auth/signup', { email, password })
  if (!res.ok) throw new Error(await readError(res))
  const data = await res.json()
  return { user: data.user ?? null, confirmationRequired: data.confirmationRequired === true }
}

export async function logout(): Promise<void> {
  await post('/auth/logout').catch(() => undefined)
}

export async function forgotPassword(email: string): Promise<void> {
  const res = await post('/auth/forgot-password', { email })
  if (!res.ok) throw new Error(await readError(res))
}

export async function resetPassword(password: string): Promise<void> {
  const res = await post('/auth/reset-password', { password })
  if (!res.ok) throw new Error(await readError(res))
}

// Single-flight: concurrent callers share one refresh request so parallel
// 401 recoveries can't burn the rotating refresh token twice.
let refreshInFlight: Promise<boolean> | null = null

export function refresh(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = post('/auth/refresh')
      .then(res => res.ok)
      .catch(() => false)
      .finally(() => {
        refreshInFlight = null
      })
  }
  return refreshInFlight
}

export function loginWithGoogle(): void {
  window.location.href = '/auth/login/google'
}

// ── Passkeys ────────────────────────────────────────────────────────────────
// Each flow is the standard two-step WebAuthn ceremony: fetch options and a
// challenge id from the gateway, run the browser prompt, send the signed
// credential back for verification. Tokens stay server-side throughout.

export interface PasskeyInfo {
  id: string
  friendly_name?: string
  created_at: string
}

async function postForJson(path: string, body?: unknown): Promise<any> {
  const res = await post(path, body)
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function signInWithPasskey(): Promise<AuthUser> {
  const { challenge_id, options } = await postForJson('/auth/passkeys/authentication/options')
  const credential = await getCredential(options)
  const data = await postForJson('/auth/passkeys/authentication/verify', {
    challenge_id,
    credential,
  })
  return data.user
}

export async function registerPasskey(): Promise<void> {
  const { challenge_id, options } = await postForJson('/auth/passkeys/registration/options')
  const credential = await createCredential(options)
  await postForJson('/auth/passkeys/registration/verify', { challenge_id, credential })
}

export async function listPasskeys(): Promise<PasskeyInfo[]> {
  const res = await fetch('/auth/passkeys', { credentials: 'include' })
  if (!res.ok) throw new Error(await readError(res))
  const data = await res.json()
  return Array.isArray(data) ? data : (data?.passkeys ?? [])
}

export async function deletePasskey(id: string): Promise<void> {
  const res = await fetch(`/auth/passkeys/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'include',
  })
  if (!res.ok) throw new Error(await readError(res))
}
