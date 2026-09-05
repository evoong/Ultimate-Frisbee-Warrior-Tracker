// Generates the local Supabase JWT signing key referenced by
// supabase/config.toml's signing_keys_path.
//
// Without it, the local stack signs HS256 and publishes an EMPTY JWKS
// ({"keys":[]}), so gateway/jwt.ts's verifyAccessToken - which verifies
// asymmetric signatures against the JWKS - cannot verify any locally minted
// token. Supplying an ES256 key makes the local stack behave like production.
//
// The output file is gitignored on purpose: it is a private signing key.
// Every developer generates their own. Run once per clone, then restart the
// stack so GoTrue picks it up.

import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const out = resolve(process.cwd(), 'supabase/signing_keys.json')

if (existsSync(out) && !process.argv.includes('--force')) {
  console.log(`${out} already exists; leaving it alone. Pass --force to replace it.`)
  process.exit(0)
}

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const jwk = privateKey.export({ format: 'jwk' })
const keys = [{ ...jwk, kid: randomUUID(), use: 'sig', alg: 'ES256', key_ops: ['sign', 'verify'] }]

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(keys, null, 2))
console.log(`Wrote ${out} (kid ${keys[0].kid}).`)
console.log('Now run: npm run db:stop && npm run db:start')
