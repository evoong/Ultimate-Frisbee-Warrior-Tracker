import { describe, expect, it } from 'vitest'
import { orderRosterPlayers } from './rosterOrder'

describe('orderRosterPlayers', () => {
  const players = [
    { id: 1, is_sub: false },
    { id: 2, is_sub: false },
    { id: 3, is_sub: true },
  ]

  it('puts approved linked player first while keeping remaining players in regular then sub order', () => {
    expect(orderRosterPlayers(players, 2)).toEqual([
      { id: 2, is_sub: false },
      { id: 1, is_sub: false },
      { id: 3, is_sub: true },
    ])
  })
})
