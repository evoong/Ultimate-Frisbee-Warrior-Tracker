import { PostHog } from "posthog-node";

const posthog = process.env.POSTHOG_PROJECT_TOKEN
  ? new PostHog(process.env.POSTHOG_PROJECT_TOKEN, {
      host: process.env.POSTHOG_HOST,
      // Bound worst-case latency: a PostHog outage should add at most a few
      // seconds to an awaited track()/trackError() call, not the ~50s the
      // library's defaults (10s timeout x 3 retries with 3s delays) allow.
      requestTimeout: 2000,
      fetchRetryCount: 1,
    })
  : null;

// Local/dev runs never send real events, matching the free-tier safeguard
// already in place for the frontend (see frontend/lib/posthog.ts).
const enabled = process.env.NODE_ENV === "production";

export async function track(distinctId: string, event: string, properties?: Record<string, unknown>) {
  if (!enabled || !posthog) return;
  await posthog.captureImmediate({ distinctId, event, properties });
}

export async function trackError(distinctId: string, error: unknown, properties?: Record<string, unknown>) {
  if (!enabled || !posthog) return;
  await posthog.captureExceptionImmediate(error, distinctId, properties);
}

export async function shutdown() {
  await posthog?.shutdown();
}
