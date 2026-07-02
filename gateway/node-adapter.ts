import type { IncomingMessage, ServerResponse } from 'http'
import type { Gateway } from './index'

// Express/Node middleware wrapper around the web-standard gateway.
// Mount BEFORE body parsers so /db request bodies pass through untouched.
export function nodeAdapter(gateway: Gateway) {
  return async (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
    try {
      const request = await toWebRequest(req)
      const response = await gateway(request)
      if (!response) return next()
      await writeWebResponse(response, res)
    } catch (err) {
      next(err)
    }
  }
}

async function toWebRequest(req: IncomingMessage): Promise<Request> {
  // Behind Vercel/Cloudflare the original scheme arrives in x-forwarded-proto;
  // it decides cookie naming (__Host- + Secure on https).
  const proto = (firstValue(req.headers['x-forwarded-proto']) ?? 'http').split(',')[0].trim()
  const host = firstValue(req.headers['x-forwarded-host']) ?? req.headers.host ?? 'localhost'
  const url = `${proto}://${host}${req.url ?? '/'}`

  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const v of value) headers.append(name, v)
    } else {
      headers.set(name, value)
    }
  }

  const method = req.method ?? 'GET'
  let body: Uint8Array<ArrayBuffer> | undefined
  if (method !== 'GET' && method !== 'HEAD') {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    const merged = Buffer.concat(chunks)
    body = new Uint8Array(merged.length)
    body.set(merged)
  }

  return new Request(url, { method, headers, body })
}

async function writeWebResponse(response: Response, res: ServerResponse): Promise<void> {
  res.statusCode = response.status
  response.headers.forEach((value, name) => {
    if (name.toLowerCase() !== 'set-cookie') res.setHeader(name, value)
  })
  const setCookies = response.headers.getSetCookie()
  if (setCookies.length > 0) res.setHeader('Set-Cookie', setCookies)

  if (response.body) {
    const buffer = Buffer.from(await response.arrayBuffer())
    res.end(buffer)
  } else {
    res.end()
  }
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}
