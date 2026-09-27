import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Login from '../pages/Login'

const mockAuth = vi.hoisted(() => ({
  login: vi.fn(),
  signup: vi.fn(),
  loginWithGoogle: vi.fn(),
  loginWithPasskey: vi.fn(),
  loginAsGuest: vi.fn(),
  forgotPassword: vi.fn(),
}))

const mockAdminGet = vi.hoisted(() => vi.fn())

vi.mock('../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../contexts/AuthContext')>()
  return { ...actual, useAuth: () => mockAuth }
})

vi.mock('../lib/passkeys', () => ({
  passkeysAvailable: () => false,
  isCeremonyCancelled: () => false,
}))

vi.mock('../lib/adminClient', () => ({
  adminGet: (...args: unknown[]) => mockAdminGet(...args),
}))

vi.mock('../lib/shadcn/card', () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: React.ReactNode }) => <h1>{children}</h1>,
  CardDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  CardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

function renderAdminLogin() {
  return render(
    <MemoryRouter initialEntries={['/admin/login']}>
      <Routes>
        <Route path="/admin/login" element={<Login adminOnly />} />
        <Route path="/admin" element={<div>admin dashboard</div>} />
      </Routes>
    </MemoryRouter>
  )
}

describe('admin sign-in', () => {
  it('offers admin sign-in only, with no signup, guest, or social controls', () => {
    renderAdminLogin()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Create account' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Forgot password?' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Continue as a guest' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Continue with Google' })).not.toBeInTheDocument()
  })

  it('lands the signed-in admin on /admin', async () => {
    mockAuth.login.mockResolvedValueOnce(undefined)
    mockAdminGet.mockResolvedValueOnce({ role: 'superadmin' })
    renderAdminLogin()
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'admin@example.com' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => {
      expect(mockAuth.login).toHaveBeenCalledWith('admin@example.com', 'password123')
      expect(screen.getByText('admin dashboard')).toBeInTheDocument()
    })
  })

  it('stays on sign-in for a non-admin, with a clear error', async () => {
    mockAuth.login.mockResolvedValueOnce(undefined)
    mockAdminGet.mockRejectedValueOnce(new Error('not an admin'))
    renderAdminLogin()
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => {
      expect(screen.getByText('This account is not a platform administrator.')).toBeInTheDocument()
      expect(screen.queryByText('admin dashboard')).not.toBeInTheDocument()
    })
  })
})
