import { verifyAccessToken } from './jwt.js'
import { parseCookies, cookieNames } from './cookies.js'
import { createMembershipLookup } from './membership.js'
import { sbGet } from './supabaseRest.js'

export interface FlagsConfig {
  supabaseUrl: string
  supabaseSecretKey: string
  jwksUrl: string
}

export async function handleFlagsRequest(
  config: FlagsConfig,
  request: Request
): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname !== '/api/flags' || request.method !== 'GET') return null

  const token = parseCookies(request)[cookieNames(url).accessToken]
  const claims = token ? await verifyAccessToken(token, config.jwksUrl, config.supabaseUrl) : null
  if (!claims) return new Response(JSON.stringify({ error: 'not authenticated' }), { status: 401, headers: { 'Content-Type': 'application/json' } })
  if (claims.isAnonymous) return new Response(JSON.stringify({ error: 'not a member of any team' }), { status: 403, headers: { 'Content-Type': 'application/json' } })

  const membershipLookup = createMembershipLookup({
    supabaseUrl: config.supabaseUrl,
    supabaseSecretKey: config.supabaseSecretKey,
  })
  const teams = await membershipLookup.teamsFor(claims.sub)
  const orgIds = teams.map(t => t.team_id)

  const registryFlags = await sbGet(config, '/feature_flags?select=key,default_on')
  const overrides = orgIds.length > 0 
    ? await sbGet(config, `/org_feature_flags?org_id=in.(${orgIds.join(',')})&select=org_id,flag_key,enabled`)
    : []

  const flags: Record<number, Record<string, boolean>> = {}
  for (const orgId of orgIds) {
    flags[orgId] = {}
    for (const f of registryFlags) {
      const override = overrides.find((o: any) => o.org_id === orgId && o.flag_key === f.key)
      flags[orgId][f.key] = override ? override.enabled : f.default_on
    }
  }

  return new Response(JSON.stringify({ flags }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
