import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import CreateOrganization from '../pages/CreateOrganization'

const refreshSession = vi.fn()
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ createTeam: vi.fn(), logout: vi.fn(), user: { email: 'a@b.com' }, refreshSession }),
}))

const rpc = vi.fn().mockResolvedValue({ error: null })
vi.mock('../lib/supabase', () => ({
  supabase: {
    rpc: (...a: unknown[]) => rpc(...a),
    from: (table: string) => {
      const rows = table === 'organizations' ? [{ id: 7, name: 'Storm' }] : []
      const res = Promise.resolve({ data: rows, error: null })
      return { select: () => ({ order: () => res }) }
    },
  },
}))

describe('CreateOrganization', () => {
  it('re-reads the session to pick up an invite sent after sign-in', async () => {
    render(<CreateOrganization />)
    fireEvent.click(screen.getByRole('button', { name: /check for invites/i }))
    await waitFor(() => expect(refreshSession).toHaveBeenCalled())
  })

  it('requests to join a public team', async () => {
    render(<CreateOrganization />)
    fireEvent.click(await screen.findByRole('button', { name: /request to join/i }))
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('request_to_join', { p_team_id: 7 }))
  })
})
