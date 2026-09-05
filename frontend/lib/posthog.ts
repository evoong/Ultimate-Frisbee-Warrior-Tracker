import posthog from 'posthog-js'

const key = import.meta.env.VITE_PUBLIC_POSTHOG_KEY
const host = import.meta.env.VITE_PUBLIC_POSTHOG_HOST

if (key) {
  posthog.init(key, {
    api_host: host,
    defaults: '2026-01-30', // enables capture_pageview: 'history_change' so React Router route changes fire $pageview (plain `true` only captures the initial hard load)
    person_profiles: 'identified_only', // avoid billing for anonymous visitors on paid tiers
    capture_exceptions: true, // feeds the Error Tracking product configured in PostHog
    loaded: (ph) => {
      // Keep local dev traffic off the free-tier event/replay quota — only
      // deployed traffic should count against usage.
      if (import.meta.env.DEV) ph.opt_out_capturing()
    },
  })
}

export { posthog }
