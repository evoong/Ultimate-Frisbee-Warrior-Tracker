import assert from 'node:assert/strict'
import { createMembershipLookup } from './membership.ts'

const realFetch = globalThis.fetch.bind(globalThis)
let mode = 'empty'
globalThis.fetch = async (url) => {
  const u = String(url)
  if (mode === 'approved') {
    return Response.json([{ player_id: 101 }])
  }
  if (mode === 'error') return new Response('boom', { status: 500 })
  if (mode === 'malformed') return Response.json({ not: 'an array' })
  return Response.json([])
}
// Distinct userIds per scenario: linkCache is keyed by user, so a cached
// result from one case would satisfy the next without a fetch and hide a
// fail-open bug.
try {
  const lookup = createMembershipLookup({ supabaseUrl: 'https://example.test', supabaseSecretKey: 'k' })

  mode = 'approved'
  assert.equal(await lookup.playerLinkFor('u1', 1), 101, 'approved link resolves the player_id')

  mode = 'empty'
  assert.equal(await lookup.playerLinkFor('u2', 1), null, 'no approved link resolves null')

  mode = 'error'
  await assert.rejects(() => lookup.playerLinkFor('u3', 1), /player link lookup failed: 500/,
    'a non-2xx lookup THROWS, never resolves null')

  mode = 'malformed'
  await assert.rejects(() => lookup.playerLinkFor('u4', 1), /player link lookup returned a non-array body/,
    'a non-array body THROWS, never resolves null')

  mode = 'approved'
  assert.equal(await lookup.playerLinkFor('u1', 1), 101, '30s TTL cache serves repeat calls for the same user')
  console.log('✓ gateway/playerLink.test.mjs all passed')
} finally {
  globalThis.fetch = realFetch
}
