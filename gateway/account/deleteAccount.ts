import { sbGet, sbUpsertIgnore, sbWrite } from '../supabaseRest.js'
import type { ActionsConfig } from '../supabaseRest.js'
import { cookieNames, parseCookies } from '../cookies.js'
import { csrfViolation } from '../csrf.js'

export type ServiceConfig = ActionsConfig

interface CallerIdentity {
  id: string
  email: string | null
}

interface GoTrueUser {
  id?: string
  email?: string
}

interface CaptainTeam {
  team_id: number
  name: string | null
  trial_started_at: string | null
  stripe_customer_id: string | null
}

interface Blockers {
  isPlatformAdmin: boolean
  soleCaptainTeams: { team_id: number; name: string | null }[]
  captainTeams: CaptainTeam[]
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

async function identify(config: ServiceConfig, bearer: string): Promise<CallerIdentity | null> {
  try {
    const res = await fetch(`${config.supabaseUrl}/auth/v1/user`, {
      headers: { apikey: config.supabaseSecretKey, Authorization: bearer },
    })
    if (!res.ok) return null
    const data = (await res.json()) as GoTrueUser | null
    if (!data || typeof data.id !== 'string' || !data.id) return null
    const email = typeof data.email === 'string' && data.email ? data.email : null
    return { id: data.id, email }
  } catch {
    return null
  }
}

async function getBlockers(config: ServiceConfig, userId: string): Promise<Blockers> {
  const adminRows = await sbGet(config, `/platform_admins?select=user_id&user_id=eq.${encodeURIComponent(userId)}`)
  if (!Array.isArray(adminRows)) throw new Error('platform_admins lookup returned a non-array body')
  const isPlatformAdmin = adminRows.length > 0

  const captainRows = await sbGet(
    config,
    `/team_members?select=team_id,teams:organizations(name,trial_started_at,stripe_customer_id)` +
      `&user_id=eq.${encodeURIComponent(userId)}&role=eq.captain`
  )
  if (!Array.isArray(captainRows)) throw new Error('team_members lookup returned a non-array body')

  const captainTeams: CaptainTeam[] = []
  const soleCaptainTeams: { team_id: number; name: string | null }[] = []
  for (const row of captainRows) {
    const team: CaptainTeam = {
      team_id: row.team_id,
      name: row.teams?.name ?? null,
      trial_started_at: row.teams?.trial_started_at ?? null,
      stripe_customer_id: row.teams?.stripe_customer_id ?? null,
    }
    captainTeams.push(team)
    const otherCaptains = await sbGet(
      config,
      `/team_members?select=id&team_id=eq.${encodeURIComponent(row.team_id)}` +
        `&role=eq.captain&user_id=neq.${encodeURIComponent(userId)}`
    )
    if (!Array.isArray(otherCaptains)) throw new Error('captain count returned a non-array body')
    if (otherCaptains.length === 0) soleCaptainTeams.push({ team_id: team.team_id, name: team.name })
  }

  return { isPlatformAdmin, soleCaptainTeams, captainTeams }
}

async function applyBan(config: ServiceConfig, userId: string): Promise<boolean> {
  try {
    const res = await fetch(`${config.supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      method: 'PUT',
      headers: {
        apikey: config.supabaseSecretKey,
        Authorization: `Bearer ${config.supabaseSecretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ban_duration: '876000h' }),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function handleAccountDeleteRequest(
  config: ServiceConfig,
  request: Request
): Promise<Response | null> {
  const url = new URL(request.url)
  const route = `${request.method} ${url.pathname}`
  if (route !== 'GET /api/account/delete/blockers' && route !== 'POST /api/account/delete') return null

  const csrf = csrfViolation(request, url)
  if (csrf) return csrf

  const cookieToken = parseCookies(request)[cookieNames(url).accessToken]
  const bearer =
    request.headers.get('Authorization') ?? (cookieToken ? `Bearer ${cookieToken}` : null)
  const caller = bearer ? await identify(config, bearer) : null
  if (!caller) return json({ error: 'not authenticated' }, 401)

  try {
    if (route === 'GET /api/account/delete/blockers') {
      const blockers = await getBlockers(config, caller.id)
      return json({
        deletable: !blockers.isPlatformAdmin && blockers.soleCaptainTeams.length === 0,
        isPlatformAdmin: blockers.isPlatformAdmin,
        soleCaptainTeams: blockers.soleCaptainTeams,
      })
    }

    let payload: Record<string, unknown>
    try {
      payload = await request.json()
    } catch {
      return json({ error: 'body must be JSON' }, 400)
    }
    const confirmationEmail = payload?.confirmationEmail
    if (
      typeof confirmationEmail !== 'string' ||
      !confirmationEmail ||
      caller.email === null ||
      confirmationEmail.toLowerCase() !== caller.email.toLowerCase()
    ) {
      return json({ error: 'confirmation email does not match account email' }, 400)
    }

    const blockers = await getBlockers(config, caller.id)
    if (blockers.isPlatformAdmin || blockers.soleCaptainTeams.length > 0) {
      return json(
        {
          error: 'account cannot be deleted',
          deletable: false,
          isPlatformAdmin: blockers.isPlatformAdmin,
          soleCaptainTeams: blockers.soleCaptainTeams,
        },
        409
      )
    }

    const trialUsed = blockers.captainTeams.some((t) => t.trial_started_at !== null)
    const stripeCustomerId =
      blockers.captainTeams.find((t) => t.stripe_customer_id !== null)?.stripe_customer_id ?? null
    const tombstoneEmail = caller.email.toLowerCase()

    await sbUpsertIgnore(
      config,
      '/deleted_accounts',
      {
        email: tombstoneEmail,
        user_id: caller.id,
        trial_used: trialUsed,
        stripe_customer_id: stripeCustomerId,
      },
      'email'
    )

    const tombstone = await sbGet(
      config,
      `/deleted_accounts?select=user_id&email=eq.${encodeURIComponent(tombstoneEmail)}`
    )
    if (!Array.isArray(tombstone) || tombstone.length === 0) throw new Error('tombstone read-back failed')
    if (tombstone[0]?.user_id !== caller.id) return json({ error: 'account cannot be deleted' }, 409)

    await sbWrite(config, 'DELETE', `/team_members?user_id=eq.${encodeURIComponent(caller.id)}`)
    await sbWrite(config, 'DELETE', `/player_links?user_id=eq.${encodeURIComponent(caller.id)}`)

    if (!(await applyBan(config, caller.id))) {
      return json({ error: 'account deletion is incomplete, try again' }, 500)
    }

    return json({ success: true })
  } catch {
    return json({ error: 'service temporarily unavailable, try again later' }, 503)
  }
}
