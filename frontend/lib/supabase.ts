import { createClient } from '@supabase/supabase-js'

// All Supabase traffic goes through the same-origin auth gateway (/db/*),
// which holds the session in httpOnly cookies and injects the real apikey +
// user Authorization header. No Supabase URL or key ships in this bundle,
// and no token is ever readable from JavaScript.
export const supabase = createClient(
  `${window.location.origin}/db`,
  'proxy', // placeholder; the gateway overwrites credentials
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        fetch(input, { ...init, credentials: 'include' }),
    },
  }
)
