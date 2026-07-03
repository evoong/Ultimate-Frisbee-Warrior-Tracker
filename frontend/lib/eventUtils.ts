// Single source of truth for which event types count as a turnover.
// event_types in the DB: Assist, Block, Caught OB, Drop, Goal, Opponent Goal, Pull, Throwaway
export const TURNOVER_EVENT_TYPES = ['Turnover', 'Throwaway', 'Drop'] as const

export function isTurnoverEvent(eventType: string): boolean {
  return (TURNOVER_EVENT_TYPES as readonly string[]).includes(eventType)
}
