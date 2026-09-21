import { describe, it, expect } from 'vitest'
import { isRangePending, settleRange } from './loadingState'

const base = { settledStats: [] as unknown, loading: false, readsPairings: false, pairingsLoading: false }

describe('isRangePending', () => {
  it('is pending before the first fetch has even fired', () => {
    // The bug this exists for. useApiCall starts loading at false, and the
    // season default has not resolved yet, so without this the page reports
    // "no stats available" before it has asked for any.
    expect(isRangePending({ ...base, settledStats: undefined })).toBe(true)
  })

  it('is pending while a fetch is in flight', () => {
    expect(isRangePending({ ...base, loading: true })).toBe(true)
  })

  it('is settled once stats have arrived and nothing is in flight', () => {
    expect(isRangePending({ ...base, settledStats: [] })).toBe(false)
  })

  it('waits on pairings only for a tab that reads them', () => {
    expect(isRangePending({ ...base, readsPairings: true, pairingsLoading: true })).toBe(true)
    // Me and Player Rankings must not wait on a round trip for a panel that is
    // not on screen.
    expect(isRangePending({ ...base, readsPairings: false, pairingsLoading: true })).toBe(false)
  })

  it('treats an empty result as arrived, not as missing', () => {
    // A range with genuinely no stats settles. Otherwise the page would sit on
    // a skeleton forever rather than saying there is nothing here.
    expect(isRangePending({ ...base, settledStats: [] })).toBe(false)
  })
})

// Wiring regression: Stats.tsx used to gate the write to its `settled` ref on
// `rangePending` itself, which reads `settled.current.stats` -- the very
// value the write is supposed to produce. Since that value starts undefined
// and the write never ran, `rangePending` was true forever and the page
// rendered skeletons permanently. These tests thread `previous` from one
// call's `nextSettled` into the next, the same way a `useRef` does across
// renders, and cover the four states the fix has to get right.
describe('settleRange', () => {
  const args = (over: Partial<Parameters<typeof settleRange>[0]>) => ({
    previous: {} as { stats?: number[]; pairings?: string[] },
    statsIn: undefined as number[] | undefined,
    pairingsIn: undefined as string[] | undefined,
    loading: false,
    readsPairings: false,
    pairingsLoading: false,
    ...over,
  })

  it('mount, no fetch fired yet: stays pending', () => {
    // useApiCall starts `loading` false before the first fetch fires, so
    // nothing here is "in flight" -- the write runs, but statsIn is still
    // undefined, so the range must still read as pending.
    const { nextSettled, rangePending } = settleRange(args({}))
    expect(nextSettled.stats).toBeUndefined()
    expect(rangePending).toBe(true)
  })

  it('fetch in flight: stays pending and does not write', () => {
    const previous = { stats: undefined, pairings: undefined }
    const { nextSettled, rangePending } = settleRange(args({ previous, loading: true, statsIn: [1, 2] }))
    // The in-flight fetch's data must not be written early.
    expect(nextSettled.stats).toBeUndefined()
    expect(rangePending).toBe(true)
  })

  it('stats arrived: writes and settles', () => {
    const { nextSettled, rangePending } = settleRange(args({ statsIn: [1, 2, 3] }))
    expect(nextSettled.stats).toEqual([1, 2, 3])
    expect(rangePending).toBe(false)
  })

  it('a later range change keeps the previous range on screen while pending', () => {
    // Simulate two renders: the first settles a range, the second starts a
    // new fetch for a different range.
    const first = settleRange(args({ statsIn: [1, 2, 3] }))
    expect(first.rangePending).toBe(false)

    const second = settleRange(args({ previous: first.nextSettled, loading: true, statsIn: [9, 9] }))
    // Still showing the old range's rows, not the new (unsettled) fetch, and
    // not nothing.
    expect(second.nextSettled.stats).toEqual([1, 2, 3])
    expect(second.rangePending).toBe(true)
  })

  it('a tab that does not read pairings does not wait on them', () => {
    const { rangePending } = settleRange(args({ statsIn: [1], readsPairings: false, pairingsLoading: true }))
    expect(rangePending).toBe(false)
  })

  it('an overview-style tab waits on pairings too', () => {
    const { nextSettled, rangePending } = settleRange(
      args({ statsIn: [1], readsPairings: true, pairingsLoading: true }),
    )
    // The write itself is held back while pairings are still loading, since
    // committing stats alone would publish a half-loaded range to a tab that
    // reads both.
    expect(nextSettled.stats).toBeUndefined()
    expect(rangePending).toBe(true)
  })
})
