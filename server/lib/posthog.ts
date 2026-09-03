import { PostHog } from "posthog-node";

const posthog = process.env.POSTHOG_PROJECT_TOKEN
  ? new PostHog(process.env.POSTHOG_PROJECT_TOKEN, { host: process.env.POSTHOG_HOST })
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
