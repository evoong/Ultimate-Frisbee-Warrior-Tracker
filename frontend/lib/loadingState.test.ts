import { describe, it, expect } from 'vitest'
import { isRangePending } from './loadingState'

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
