import { useState } from "react"
import { Check, ChevronsUpDown, Disc } from "lucide-react"
import type { TeamMembership } from "../../lib/authClient"
import { Popover, PopoverContent, PopoverTrigger } from "../../lib/shadcn/popover"
import { cn } from "../../lib/shadcn/utils"
import { initials } from "./identity"

type WorkspaceSwitcherProps = {
  teams: TeamMembership[]
  currentTeamId: number | null
  switchTeam: (teamId: number) => void
  /**
   * "sidebar" is the desktop rail, where the row collapses to just the brand
   * tile in icon mode. "bar" is the mobile header, which has no collapsed
   * state and sits on `--card` rather than `--sidebar-background`.
   */
  variant?: "sidebar" | "bar"
}

/**
 * The workspace identity at the top of the shell: which team's dashboard you
 * are actually looking at. Someone running a summer rec roster and a separate
 * indoor winter team needs that answer before anything else on screen means
 * something, and a bare product wordmark never gave it.
 *
 * The product name stays as the overline above the team name -- pairing, not
 * replacing -- so the app still says what it is without spending the loudest
 * line in the sidebar on a word that never changes.
 *
 * Note this switches *teams*, not seasons. Season is a per-page filter today,
 * and each page derives its own default (see lib/seasonUtils.ts); hoisting it
 * into global state is a real change to how Schedule/Stats/Roster choose what
 * to show, not a nav change.
 */
export default function WorkspaceSwitcher({
  teams,
  currentTeamId,
  switchTeam,
  variant = "sidebar",
}: WorkspaceSwitcherProps) {
  const [open, setOpen] = useState(false)
  const current = teams.find(t => t.organization_id === currentTeamId)
  // A guest is signed in to a public team but is a member of none, so `teams`
  // is empty and there is no team name to show. Rather than print the product
  // name on both lines, the overline drops away and the wordmark takes the
  // primary line on its own -- the guest banner below the header says the
  // rest.
  const workspace = current?.name ?? "Warrior Tracker"
  const switchable = teams.length > 1

  const collapsible = variant === "sidebar"

  const row = (
    <>
      {/* The brand mark stays neutral. Chartreuse is the app's one accent and
          it means "this is the active thing" -- spending it on a logo, which
          is never active or inactive, is exactly the decoration the schedule
          ledger's rules rule out, and it would weaken the active nav rail by
          putting the same colour 30px above it. */}
      <span className="grid size-8 shrink-0 place-items-center rounded-[6px] bg-sidebar-primary text-sidebar-primary-foreground">
        <Disc className="size-[17px]" strokeWidth={2.25} />
      </span>
      <span
        className={cn(
          "min-w-0 text-left",
          // In the rail the label takes the leftover width so the chevron
          // parks against the right edge. In the mobile header the row is
          // only as wide as its content, so the chevron hugs the team name
          // instead of drifting into the middle of the bar.
          collapsible && "flex-1 group-data-[collapsible=icon]:hidden"
        )}
      >
        {current && (
          <span className="nav-mono block text-[9px] uppercase leading-none tracking-[0.17em] text-muted-foreground">
            Warrior Tracker
          </span>
        )}
        <span
          className={cn(
            "block truncate text-[13.5px] font-semibold leading-none tracking-[-0.012em]",
            current && "mt-[5px]"
          )}
        >
          {workspace}
        </span>
      </span>
      {switchable && (
        <ChevronsUpDown
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground",
            collapsible && "group-data-[collapsible=icon]:hidden"
          )}
          strokeWidth={2}
        />
      )}
    </>
  )

  const rowClass = cn(
    "flex items-center gap-2.5 rounded-md p-1.5 transition-colors",
    collapsible ? "w-full group-data-[collapsible=icon]:!p-1" : "max-w-full"
  )

  // With a single team there is nothing to switch to, so the row stays a
  // label. Rendering a dropdown that opens onto one row is the kind of dead
  // control that makes a shell feel assembled rather than designed.
  if (!switchable) {
    return <div className={rowClass}>{row}</div>
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Current team: ${workspace}. Switch team`}
          className={cn(
            rowClass,
            "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          )}
        >
          {row}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side={variant === "bar" ? "bottom" : "right"}
        align="start"
        sideOffset={8}
        className="w-64 p-1.5"
      >
        <p className="nav-mono px-2 pb-1.5 pt-1 text-[9px] uppercase tracking-[0.17em] text-muted-foreground">
          Your teams
        </p>
        <ul className="flex flex-col">
          {teams.map(team => {
            const isCurrent = team.organization_id === currentTeamId
            return (
              <li key={team.organization_id}>
                <button
                  type="button"
                  onClick={() => {
                    switchTeam(team.organization_id)
                    setOpen(false)
                  }}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-[5px] px-2 py-1.5 text-left transition-colors",
                    "hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                  )}
                >
                  <span
                    className={cn(
                      "nav-mono grid size-7 shrink-0 place-items-center rounded-[5px] text-[10px] font-bold",
                      isCurrent
                        ? "bg-[hsl(var(--nav-accent))] text-[hsl(var(--nav-accent-on))]"
                        : "bg-muted text-muted-foreground"
                    )}
                  >
                    {initials(team.name)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium leading-tight">
                      {team.name}
                    </span>
                    <span className="nav-mono mt-0.5 block text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
                      {team.role}
                    </span>
                  </span>
                  {isCurrent && (
                    <Check
                      className="size-3.5 shrink-0 text-[hsl(var(--nav-accent-ink))]"
                      strokeWidth={2.5}
                    />
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
