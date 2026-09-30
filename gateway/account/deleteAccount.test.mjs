import assert from 'node:assert/strict'
import { handleAccountDeleteRequest } from './deleteAccount.ts'

let failed = 0
function check(name, cond) {
  console.log(`${cond ? '✓' : '✗'}  ${name}`)
  if (!cond) failed++
}

const config = {
  supabaseUrl: 'https://example.test',
  supabaseSecretKey: 'secret-key',
}

const realFetch = globalThis.fetch
function stub(impl) {
  globalThis.fetch = async (url, init) => impl(String(url), init)
}
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

try {
  {
    stub(async () => {
      throw new Error('no upstream call expected')
    })
    const notHandled = [
      ['GET', '/api/account/delete'],
      ['POST', '/api/account/delete/blockers'],
      ['GET', '/api/account/delete/blockers/extra'],
      ['PUT', '/api/account/delete'],
      ['GET', '/api/admin'],
      ['DELETE', '/api/account/delete'],
    ]
    for (const [method, path] of notHandled) {
      const res = await handleAccountDeleteRequest(config, new Request(`https://app.test${path}`, { method }))
      check(`route ${method} ${path} not handled`, res === null)
    }
  }

  {
    stub(async () => {
      throw new Error('no upstream call expected')
    })
    const res = await handleAccountDeleteRequest(
      config,
      new Request('https://app.test/api/account/delete/blockers', { method: 'GET', headers: {} })
    )
    check('missing bearer token returns 401', res.status === 401)
  }

  {
    stub(async (url) => {
      if (url === 'https://example.test/auth/v1/user') return jsonResponse({}, 401)
      throw new Error('no further upstream call expected')
    })
    const res = await handleAccountDeleteRequest(
      config,
      new Request('https://app.test/api/account/delete/blockers', {
        method: 'GET',
        headers: { Authorization: 'Bearer token-123' },
      })
    )
    check('GoTrue rejection returns 401', res.status === 401)
  }

  {
    stub(async (url) => {
      if (url === 'https://example.test/auth/v1/user') {
        return jsonResponse({ id: 'u-admin', email: 'admin@test.com' })
      }
      if (url.startsWith('https://example.test/rest/v1/platform_admins')) {
        return jsonResponse([{ user_id: 'u-admin', role: 'superadmin' }])
      }
      if (url.startsWith('https://example.test/rest/v1/team_members')) return jsonResponse([])
      throw new Error(`unexpected upstream call: ${url}`)
    })
    const res = await handleAccountDeleteRequest(
      config,
      new Request('https://app.test/api/account/delete/blockers', {
        method: 'GET',
        headers: { Authorization: 'Bearer token-123' },
      })
    )
    const body = await res.json()
    check('platform admin blocker status 200', res.status === 200)
    check('platform admin has blocker', body.deletable === false && body.isPlatformAdmin === true)
    check('platform admin has no sole-captain teams', Array.isArray(body.soleCaptainTeams) && body.soleCaptainTeams.length === 0)
  }

  {
    stub(async (url) => {
      if (url === 'https://example.test/auth/v1/user') {
        return jsonResponse({ id: 'u-captain', email: 'captain@test.com' })
      }
      if (url.startsWith('https://example.test/rest/v1/platform_admins')) return jsonResponse([])
      if (url.startsWith('https://example.test/rest/v1/team_members')) {
        if (url.includes('user_id=neq.')) return jsonResponse([])
        return jsonResponse([
          { team_id: 10, teams: { name: 'Sole Team', trial_started_at: null, stripe_customer_id: null } },
        ])
      }
      throw new Error(`unexpected upstream call: ${url}`)
    })
    const res = await handleAccountDeleteRequest(
      config,
      new Request('https://app.test/api/account/delete/blockers', {
        method: 'GET',
        headers: { Authorization: 'Bearer token-123' },
      })
    )
    const body = await res.json()
    check('sole captain has blocker', res.status === 200 && body.deletable === false)
    check(
      'sole captain team listed',
      Array.isArray(body.soleCaptainTeams) && body.soleCaptainTeams.length === 1 &&
        body.soleCaptainTeams[0].team_id === 10 && body.soleCaptainTeams[0].name === 'Sole Team'
    )
    check('sole captain is not a platform admin', body.isPlatformAdmin === false)
  }

  {
    stub(async (url) => {
      if (url === 'https://example.test/auth/v1/user') {
        return jsonResponse({ id: 'u-co', email: 'co@test.com' })
      }
      if (url.startsWith('https://example.test/rest/v1/platform_admins')) return jsonResponse([])
      if (url.startsWith('https://example.test/rest/v1/team_members')) {
        if (url.includes('user_id=neq.')) return jsonResponse([{ id: 55 }])
        return jsonResponse([
          { team_id: 10, teams: { name: 'Shared Team', trial_started_at: null, stripe_customer_id: null } },
        ])
      }
      throw new Error(`unexpected upstream call: ${url}`)
    })
    const res = await handleAccountDeleteRequest(
      config,
      new Request('https://app.test/api/account/delete/blockers', {
        method: 'GET',
        headers: { Authorization: 'Bearer token-123' },
      })
    )
    const body = await res.json()
    check('co-captain is deletable', res.status === 200 && body.deletable === true)
    check('co-captain has no sole-captain teams', body.soleCaptainTeams.length === 0)
  }

  {
    let tombstoneWritten = false
    let membersDeleted = false
    let linksDeleted = false
    let banApplied = false
    const calls = []
    stub(async (url, init) => {
      const method = init?.method ?? 'GET'
      calls.push(`${method} ${url}`)
      if (url === 'https://example.test/auth/v1/user') {
        return jsonResponse({ id: 'u-clean', email: 'clean@test.com' })
      }
      if (url.startsWith('https://example.test/rest/v1/platform_admins')) return jsonResponse([])
      if (url.startsWith('https://example.test/rest/v1/team_members')) {
        if (method === 'DELETE') {
          membersDeleted = true
          return jsonResponse([])
        }
        if (url.includes('user_id=neq.')) return jsonResponse([{ id: 55 }])
        return jsonResponse([])
      }
      if (url.startsWith('https://example.test/rest/v1/player_links')) {
        linksDeleted = true
        return jsonResponse([])
      }
      if (url.startsWith('https://example.test/rest/v1/deleted_accounts')) {
        if (method === 'POST') {
          tombstoneWritten = true
          return jsonResponse([], 201)
        }
        return jsonResponse([{ user_id: 'u-clean' }])
      }
      if (url.startsWith('https://example.test/auth/v1/admin/users/')) {
        if (method === 'PUT') {
          banApplied = true
          return jsonResponse({})
        }
      }
      throw new Error(`unexpected upstream call: ${method} ${url}`)
    })
    const res = await handleAccountDeleteRequest(
      config,
      new Request('https://app.test/api/account/delete', {
        method: 'POST',
        headers: { Authorization: 'Bearer token-123', 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmationEmail: 'Clean@Test.com' }),
      })
    )
    const body = await res.json()
    check('clean delete returns 200', res.status === 200)
    check('clean delete returns success', body.success === true)
    check('tombstone written', tombstoneWritten)
    check('memberships deleted', membersDeleted)
    check('player links deleted', linksDeleted)
    check('ban applied', banApplied)
    const idx = (prefix) => calls.findIndex((c) => c.startsWith(prefix))
    check(
      'tombstone precedes membership delete, links delete, and ban',
      idx('POST https://example.test/rest/v1/deleted_accounts') <
        idx('DELETE https://example.test/rest/v1/team_members') &&
        idx('DELETE https://example.test/rest/v1/team_members') <
          idx('DELETE https://example.test/rest/v1/player_links') &&
        idx('DELETE https://example.test/rest/v1/player_links') < idx('PUT https://example.test/auth/v1/admin/users/')
    )
  }

  {
    let tombstoneBody = null
    stub(async (url, init) => {
      const method = init?.method ?? 'GET'
      if (url === 'https://example.test/auth/v1/user') {
        return jsonResponse({ id: 'u-x', email: 'x@test.com' })
      }
      if (url.startsWith('https://example.test/rest/v1/platform_admins')) return jsonResponse([])
      if (url.startsWith('https://example.test/rest/v1/team_members')) {
        if (method === 'DELETE') return jsonResponse([])
        if (url.includes('user_id=neq.')) return jsonResponse([{ id: 3 }])
        return jsonResponse([
          { team_id: 8, teams: { name: 'NoTrial', trial_started_at: null, stripe_customer_id: 'cus_2' } },
          { team_id: 7, teams: { name: 'Trialled', trial_started_at: '2026-01-01T00:00:00Z', stripe_customer_id: 'cus_1' } },
        ])
      }
      if (url.startsWith('https://example.test/rest/v1/player_links')) return jsonResponse([])
      if (url.startsWith('https://example.test/rest/v1/deleted_accounts')) {
        if (method === 'POST') {
          tombstoneBody = JSON.parse(init.body)
          return jsonResponse([], 201)
        }
        return jsonResponse([{ user_id: 'u-x' }])
      }
      if (url.startsWith('https://example.test/auth/v1/admin/users/')) return jsonResponse({})
      throw new Error(`unexpected upstream call: ${method} ${url}`)
    })
    const res = await handleAccountDeleteRequest(
      config,
      new Request('https://app.test/api/account/delete', {
        method: 'POST',
        headers: { Authorization: 'Bearer token-123', 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmationEmail: 'x@test.com' }),
      })
    )
    check('trial-carrying delete returns 200', res.status === 200)
    check(
      'tombstone records trial_used and first non-null stripe customer',
      tombstoneBody &&
        tombstoneBody.email === 'x@test.com' &&
        tombstoneBody.user_id === 'u-x' &&
        tombstoneBody.trial_used === true &&
        tombstoneBody.stripe_customer_id === 'cus_2'
    )
  }

  {
    let tombstoneWritten = false
    stub(async (url) => {
      if (url === 'https://example.test/auth/v1/user') {
        return jsonResponse({ id: 'u-clean', email: 'clean@test.com' })
      }
      if (url.startsWith('https://example.test/rest/v1/')) tombstoneWritten = url.includes('/deleted_accounts')
      return jsonResponse([])
    })
    const res = await handleAccountDeleteRequest(
      config,
      new Request('https://app.test/api/account/delete', {
        method: 'POST',
        headers: { Authorization: 'Bearer token-123', 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmationEmail: 'wrong@test.com' }),
      })
    )
    check('confirmation mismatch returns 400', res.status === 400)
    check('confirmation mismatch writes nothing', tombstoneWritten === false)
  }

  {
    stub(async (url) => {
      if (url === 'https://example.test/auth/v1/user') {
        return jsonResponse({ id: 'u-clean', email: 'clean@test.com' })
      }
      return jsonResponse([])
    })
    const missing = await handleAccountDeleteRequest(
      config,
      new Request('https://app.test/api/account/delete', {
        method: 'POST',
        headers: { Authorization: 'Bearer token-123', 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
    )
    check('missing confirmation email returns 400', missing.status === 400)

    const notJson = await handleAccountDeleteRequest(
      config,
      new Request('https://app.test/api/account/delete', {
        method: 'POST',
        headers: { Authorization: 'Bearer token-123', 'Content-Type': 'text/plain' },
        body: 'not json',
      })
    )
    check('non-JSON body returns 400', notJson.status === 400)
  }

  {
    stub(async (url) => {
      if (url === 'https://example.test/auth/v1/user') {
        return jsonResponse({ id: 'u-guest', email: '' })
      }
      throw new Error('no further upstream call expected')
    })
    const res = await handleAccountDeleteRequest(
      config,
      new Request('https://app.test/api/account/delete', {
        method: 'POST',
        headers: { Authorization: 'Bearer token-123', 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmationEmail: 'anything@test.com' }),
      })
    )
    check('guest (no email) cannot confirm, 400', res.status === 400)
  }

  {
    let tombstoneWritten = false
    stub(async (url) => {
      if (url === 'https://example.test/auth/v1/user') {
        return jsonResponse({ id: 'u-cap', email: 'cap@test.com' })
      }
      if (url.startsWith('https://example.test/rest/v1/platform_admins')) return jsonResponse([])
      if (url.startsWith('https://example.test/rest/v1/team_members')) {
        if (url.includes('user_id=neq.')) return jsonResponse([])
        return jsonResponse([
          { team_id: 10, teams: { name: 'Sole Team', trial_started_at: null, stripe_customer_id: null } },
        ])
      }
      if (url.startsWith('https://example.test/rest/v1/deleted_accounts')) {
        tombstoneWritten = true
        return jsonResponse([])
      }
      throw new Error(`unexpected upstream call: ${url}`)
    })
    const res = await handleAccountDeleteRequest(
      config,
      new Request('https://app.test/api/account/delete', {
        method: 'POST',
        headers: { Authorization: 'Bearer token-123', 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmationEmail: 'cap@test.com' }),
      })
    )
    const body = await res.json()
    check('blocked delete returns 409', res.status === 409)
    check('409 lists blockers', body.deletable === false && body.soleCaptainTeams.length === 1)
    check('409 writes no tombstone', tombstoneWritten === false)
  }

  {
    let membersDeleted = false
    let banApplied = false
    stub(async (url, init) => {
      const method = init?.method ?? 'GET'
      if (url === 'https://example.test/auth/v1/user') {
        return jsonResponse({ id: 'u-a', email: 'a@test.com' })
      }
      if (url.startsWith('https://example.test/rest/v1/platform_admins')) return jsonResponse([])
      if (url.startsWith('https://example.test/rest/v1/team_members')) {
        if (method === 'DELETE') {
          membersDeleted = true
          return jsonResponse([])
        }
        return jsonResponse([])
      }
      if (url.startsWith('https://example.test/rest/v1/deleted_accounts')) {
        if (method === 'POST') return jsonResponse([], 201)
        return jsonResponse([{ user_id: 'u-b' }])
      }
      if (url.startsWith('https://example.test/auth/v1/admin/users/')) {
        banApplied = true
        return jsonResponse({})
      }
      throw new Error(`unexpected upstream call: ${method} ${url}`)
    })
    const res = await handleAccountDeleteRequest(
      config,
      new Request('https://app.test/api/account/delete', {
        method: 'POST',
        headers: { Authorization: 'Bearer token-123', 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmationEmail: 'a@test.com' }),
      })
    )
    check('tombstone email owned by another user returns 409', res.status === 409)
    check('mismatched tombstone mutates nothing', membersDeleted === false && banApplied === false)
  }

  {
    let tombstoneWritten = false
    stub(async (url, init) => {
      const method = init?.method ?? 'GET'
      if (url === 'https://example.test/auth/v1/user') {
        return jsonResponse({ id: 'u-clean', email: 'clean@test.com' })
      }
      if (url.startsWith('https://example.test/rest/v1/platform_admins')) return jsonResponse([])
      if (url.startsWith('https://example.test/rest/v1/team_members')) {
        if (method === 'DELETE') return jsonResponse([])
        return jsonResponse([])
      }
      if (url.startsWith('https://example.test/rest/v1/player_links')) return jsonResponse([])
      if (url.startsWith('https://example.test/rest/v1/deleted_accounts')) {
        if (method === 'POST') {
          tombstoneWritten = true
          return jsonResponse([], 201)
        }
        return jsonResponse([{ user_id: 'u-clean' }])
      }
      if (url.startsWith('https://example.test/auth/v1/admin/users/')) {
        return jsonResponse({ msg: 'ban failed' }, 500)
      }
      throw new Error(`unexpected upstream call: ${method} ${url}`)
    })
    const res = await handleAccountDeleteRequest(
      config,
      new Request('https://app.test/api/account/delete', {
        method: 'POST',
        headers: { Authorization: 'Bearer token-123', 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmationEmail: 'clean@test.com' }),
      })
    )
    const body = await res.json()
    check('ban failure returns 500', res.status === 500)
    check('ban failure keeps tombstone written', tombstoneWritten === true)
    check('ban failure response is retryable advice', typeof body.error === 'string' && body.error.length > 0)
  }

  {
    let tombstoneWritten = false
    let membersDeleted = false
    let banApplied = false
    stub(async (url, init) => {
      const method = init?.method ?? 'GET'
      if (url === 'https://example.test/auth/v1/user') {
        return jsonResponse({ id: 'u-clean', email: 'clean@test.com' })
      }
      if (url.startsWith('https://example.test/rest/v1/platform_admins')) return jsonResponse([])
      if (url.startsWith('https://example.test/rest/v1/team_members')) {
        if (method === 'DELETE') {
          membersDeleted = true
          return jsonResponse([])
        }
        return jsonResponse([])
      }
      if (url.startsWith('https://example.test/rest/v1/deleted_accounts')) {
        if (method === 'POST') {
          tombstoneWritten = true
          return jsonResponse({ message: 'boom' }, 500)
        }
        return jsonResponse([{ user_id: 'u-clean' }])
      }
      if (url.startsWith('https://example.test/auth/v1/admin/users/')) {
        banApplied = true
        return jsonResponse({})
      }
      throw new Error(`unexpected upstream call: ${method} ${url}`)
    })
    const res = await handleAccountDeleteRequest(
      config,
      new Request('https://app.test/api/account/delete', {
        method: 'POST',
        headers: { Authorization: 'Bearer token-123', 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmationEmail: 'clean@test.com' }),
      })
    )
    check('tombstone insert failure returns 503', res.status === 503)
    check('tombstone failure blocks all mutation', membersDeleted === false && banApplied === false)
  }

  {
    stub(async (url) => {
      if (url === 'https://example.test/auth/v1/user') {
        return jsonResponse({ id: 'u-clean', email: 'clean@test.com' })
      }
      if (url.startsWith('https://example.test/rest/v1/platform_admins')) {
        return jsonResponse({ message: 'database is down' }, 500)
      }
      return jsonResponse([])
    })
    const getRes = await handleAccountDeleteRequest(
      config,
      new Request('https://app.test/api/account/delete/blockers', {
        method: 'GET',
        headers: { Authorization: 'Bearer token-123' },
      })
    )
    check('blockers GET fails closed on upstream error', getRes.status === 503)

    const postRes = await handleAccountDeleteRequest(
      config,
      new Request('https://app.test/api/account/delete', {
        method: 'POST',
        headers: { Authorization: 'Bearer token-123', 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmationEmail: 'clean@test.com' }),
      })
    )
    check('delete POST fails closed on upstream error', postRes.status === 503)
  }

  {
    stub(async () => {
      throw new Error('network down')
    })
    const res = await handleAccountDeleteRequest(
      config,
      new Request('https://app.test/api/account/delete/blockers', {
        method: 'GET',
        headers: { Authorization: 'Bearer token-123' },
      })
    )
    check('GoTrue network failure reads as 401', res.status === 401)
  }
  {
    stub(async (url) => {
      throw new Error('no upstream call expected')
    })
    const res = await handleAccountDeleteRequest(
      config,
      new Request('https://app.test/api/account/delete', {
        method: 'POST',
        headers: { Origin: 'https://evil.test', 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmationEmail: 'x@test.com' }),
      })
    )
    check('cross-origin delete POST blocked by CSRF', res.status === 403)
  }

  {
    let forwardedAuth = null
    stub(async (url, init) => {
      if (url === 'https://example.test/auth/v1/user') {
        forwardedAuth = init.headers.Authorization
        return jsonResponse({ id: 'u-cookie', email: 'cookie@test.com' })
      }
      if (url.startsWith('https://example.test/rest/v1/platform_admins')) return jsonResponse([])
      if (url.startsWith('https://example.test/rest/v1/team_members')) return jsonResponse([])
      throw new Error(`unexpected upstream call: ${url}`)
    })
    const res = await handleAccountDeleteRequest(
      config,
      new Request('https://app.test/api/account/delete/blockers', {
        method: 'GET',
        headers: { Cookie: '__Host-ufwt_at=cookie-token-123' },
      })
    )
    const body = await res.json()
    check('cookie session authenticates blockers GET', res.status === 200 && body.deletable === true)
    check('cookie token forwarded as bearer to GoTrue', forwardedAuth === 'Bearer cookie-token-123')
  }
} finally {
  globalThis.fetch = realFetch
}

if (failed > 0) {
  console.log(`\n${failed} check(s) failed`)
  process.exit(1)
}
