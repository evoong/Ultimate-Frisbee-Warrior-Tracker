import { useEffect, useState } from 'react'
import { adminGet, adminRoleAtLeast, useAdminRole } from '../../lib/adminClient'
import { Skeleton } from '../../lib/shadcn/skeleton'
import { Button } from '../../lib/shadcn/button'
import OperationDialog from './OperationDialog'

type RegistryFlag = { key: string; description: string; default_on: boolean }
type Override = {
  org_id: number
  org_name: string
  flag_key: string
  enabled: boolean
  updated_by: string | null
  updated_at: string
}
type FlagsPayload = { registry: RegistryFlag[] | null; overrides: Override[] }

export default function Flags() {
  const { role } = useAdminRole()
  const [data, setData] = useState<FlagsPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [dialog, setDialog] = useState<{ title: string; input: Record<string, unknown> } | null>(null)

  const isSuperadmin = adminRoleAtLeast(role, 'superadmin')

  async function refresh() {
    setLoading(true)
    setData(await adminGet<FlagsPayload>('/flags'))
    setLoading(false)
  }

  useEffect(() => { void refresh() }, [])

  function toggleDefault(flag: RegistryFlag) {
    setDialog({
      title: `Feature flag: ${flag.key}`,
      input: { key: flag.key, org_id: null, enabled: !flag.default_on },
    })
  }

  function toggleOverride(row: Override) {
    setDialog({
      title: `Feature flag: ${row.flag_key}`,
      input: { key: row.flag_key, org_id: row.org_id, enabled: !row.enabled },
    })
  }

  if (loading) return <Skeleton className="h-64 w-full" />

  const registry = data?.registry ?? []

  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Feature flags</h1>
        <p className="text-sm text-muted-foreground">
          Global defaults and per-organization overrides. Every change is recorded in the audit log.
        </p>
      </div>

      <div className="rounded border p-4 space-y-4">
        <div>
          <h2 className="font-semibold">Global registry</h2>
          <p className="text-xs text-muted-foreground">Default value applied to orgs without an override.</p>
        </div>
        {registry.length === 0 ? (
          <p className="text-sm text-muted-foreground">No feature flags registered.</p>
        ) : (
          <div className="divide-y rounded border">
            {registry.map(flag => (
              <div key={flag.key} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-1">
                  <span className="font-mono text-sm font-medium">{flag.key}</span>
                  <p className="text-xs text-muted-foreground">{flag.description}</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground">Default: {flag.default_on ? 'On' : 'Off'}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!isSuperadmin}
                    title={!isSuperadmin ? 'Requires superadmin role' : undefined}
                    aria-label={`${flag.default_on ? 'Turn off' : 'Turn on'} ${flag.key}`}
                    onClick={() => toggleDefault(flag)}
                  >
                    {flag.default_on ? 'Turn off' : 'Turn on'}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded border p-4 space-y-4">
        <div>
          <h2 className="font-semibold">Organization overrides</h2>
          <p className="text-xs text-muted-foreground">Setting an override equal to the default removes it.</p>
        </div>
        {(data?.overrides ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No overrides. All organizations use the registry defaults.</p>
        ) : (
          <div className="overflow-x-auto rounded border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50 text-left">
                  <th className="p-3">Organization</th>
                  <th className="p-3">Flag</th>
                  <th className="p-3">State</th>
                  <th className="p-3">Updated</th>
                  <th className="p-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {(data?.overrides ?? []).map(row => (
                  <tr key={`${row.org_id}:${row.flag_key}`} className="border-b">
                    <td className="p-3">{row.org_name}</td>
                    <td className="p-3 font-mono text-xs">{row.flag_key}</td>
                    <td className="p-3">{row.enabled ? 'On' : 'Off'}</td>
                    <td className="p-3 text-xs text-muted-foreground">
                      {new Date(row.updated_at).toLocaleString()}
                    </td>
                    <td className="p-3 text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!isSuperadmin}
                        title={!isSuperadmin ? 'Requires superadmin role' : undefined}
                        aria-label={`${row.enabled ? 'Turn off' : 'Turn on'} ${row.flag_key} for ${row.org_name}`}
                        onClick={() => toggleOverride(row)}
                      >
                        {row.enabled ? 'Turn off' : 'Turn on'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {dialog && (
        <OperationDialog
          name="set_flag"
          title={dialog.title}
          input={dialog.input}
          onDone={() => { setDialog(null); void refresh() }}
          onCancel={() => setDialog(null)}
        />
      )}
    </section>
  )
}
