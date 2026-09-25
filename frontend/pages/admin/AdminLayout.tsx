import { NavLink, Outlet } from 'react-router-dom'
import { useAdminRole } from '../../lib/adminClient'

const TABS = [
  { to: '/admin/search', label: 'Search', end: true },
  { to: '/admin', label: 'Dashboard', end: true },
  { to: '/admin/orgs', label: 'Organizations', end: false },
  { to: '/admin/audit', label: 'Audit log', end: false },
  { to: '/admin/flags', label: 'Feature flags', end: false },
]

export default function AdminLayout() {
  const { role, loading } = useAdminRole()

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Checking access…</div>

  // Server-side enforcement already rejects non-admins on every request; this
  // is the friendly version of the same answer, not a second gate.
  if (!role) {
    return (
      <div className="p-6">
        <h1 className="text-lg font-semibold">Not available</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This area is limited to platform administrators.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      {/* Persistent, deliberately hard to miss: every action here is logged
          with the operator's identity, and the operator should know it. */}
      <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm">
        <strong>Admin console</strong> — signed in as <code>{role}</code>. Every action you take
        here is recorded in the audit log with your account.
      </div>

      <nav className="flex gap-4 border-b pb-2 text-sm">
        {TABS.map(t => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            className={({ isActive }) =>
              isActive ? 'font-semibold text-foreground' : 'text-muted-foreground hover:text-foreground'
            }
          >
            {t.label}
          </NavLink>
        ))}
      </nav>

      {/* Pages read the role via useAdminRole(), which shares one in-flight
          /whoami across the whole page -- no context plumbing needed. */}
      <Outlet />
    </div>
  )
}
