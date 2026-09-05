import { posthog } from './posthog'

export function track(event: string, properties?: Record<string, unknown>) {
  posthog.capture(event, properties)
}

export function trackError(error: unknown, properties?: Record<string, unknown>) {
  posthog.captureException(error, properties)
}
