export function shouldShowEventsLoading(loading: boolean, events: unknown[] | undefined): boolean {
  return loading && (!events || events.length === 0)
}
