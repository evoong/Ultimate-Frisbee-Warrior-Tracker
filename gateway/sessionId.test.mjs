import assert from 'node:assert/strict'
import { isValidSessionId } from './sessionId.ts'

assert.equal(isValidSessionId(crypto.randomUUID()), true, 'a real UUID passes')
assert.equal(isValidSessionId('s_1695000000_abc123def'), false, 'the old localStorage format is rejected')
assert.equal(isValidSessionId('not-a-uuid'), false, 'garbage rejected')
assert.equal(isValidSessionId(null), false, 'null rejected')
assert.equal(isValidSessionId(12345), false, 'non-string rejected')
assert.equal(isValidSessionId(''), false, 'empty rejected')
console.log('✓ gateway/sessionId.test.mjs all passed')
