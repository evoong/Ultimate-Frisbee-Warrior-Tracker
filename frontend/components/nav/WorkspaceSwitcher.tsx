import { useState } from "react"
import { CaretDown, Check, Disc } from "@phosphor-icons/react"
import type { TeamMembership } from "../../lib/authClient"
import { Avatar, AvatarFallback, AvatarImage } from "../../lib/shadcn/avatar"
import { Popover, PopoverContent, PopoverTrigger } from "../../lib/shadcn/popover"
import { cn } from "../../lib/shadcn/utils"
import { initials } from "./identity"

type WorkspaceSwitcherProps = {
  teams: TeamMembership[]
  currentTeamId: number | null
  switchTeam: (teamId: number) => void
  /**
   * "sidebar" is the desktop rail, where the row collapses to just the crest
   * in icon mode. "bar" is the mobile header, which has no collapsed state
   * and sits on `--card` rather than `--sidebar-background`.
   */
  variant?: "sidebar" | "bar"
}

/**
 * The team crest. A real `<Avatar>` with the monogram as its fallback, so the
 * day `TeamMembership.logo_url` is populated a logo drops straight in and the
 * row does not move -- the same contract the schedule ledger's crest keeps
 * against `MatchData.crestUrl`.
 *
 * It is a squircle, not a circle, and the fill is a near-ground grey rather
 * than a block of `--sidebar-primary`. That token is 97% L in dark and 9% in
 * light, so the old tile was a near-white chip with a dark glyph punched out
 * of it -- the loudest, highest-contrast object in a sidebar whose entire
 * palette is built to leave the cyan rail as the only thing that shouts. A
 * brand mark is never the active thing on screen; it should not be lit like
 * it is. What defines the tile now is a hairline at `--border`, one step off
 * its own fill, which is enough to read as an object without becoming one.
 */
function TeamCrest({
  name,
  logoUrl,
  className,
}: {
  name: string | null
  logoUrl?: string | null
  className?: string
}) {
  return (
    <Avatar
      className={cn(
        "size-8 shrink-0 rounded-[7px] ring-1 ring-inset ring-border",
        className
      )}
    >
      {logoUrl && <AvatarImage src={logoUrl} alt="" className="rounded-[7px]" />}
      <AvatarFallback className="nav-mono rounded-[7px] bg-muted text-[10px] font-bold tracking-[0.04em] text-foreground/80">
        {/* A guest belongs to no team, so there is no name to take a
            monogram from -- the product glyph stands in rather than two
            letters of a word the person never chose. */}
        {name ? initials(name) : <Disc className="size-[15px]" weight="bold" />}
      </AvatarFallback>
    </Avatar>
  )
}

/**
 * The workspace identity at the top of the shell: which team's dashboard you
 * are actually looking at. Someone running a summer rec roster and a separate
 * indoor winter team needs that answer before anything else on screen means
 * something, and a bare product wordmark never gave it.
 *
 * So the team name is the primary line -- 15px at weight 600, full ink -- and
 * the product name is the overline above it, at mono 9.5px in muted. It used
 * to be two nearly equal lines, 9px over 13.5px, which read as a label with a
 * caption rather than as an answer to "whose dashboard is this". Pairing, not
 * replacing: the app still says what it is, it just stops spending the
 * loudest line in the sidebar on a word that never changes.
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
      <TeamCrest name={current?.name ?? null} logoUrl={current?.logo_url} />
      <span
        className={cn(
          "min-w-0 text-left",
          // In the rail the label takes the leftover width so the caret parks
          // against the right edge. In the mobile header the row is only as
          // wide as its content, so the caret hugs the team name instead of
          // drifting into the middle of the bar.
          collapsible && "flex-1 group-data-[collapsible=icon]:hidden"
        )}
      >
        {current && (
          <span className="nav-mono block text-[9.5px] uppercase leading-none tracking-[0.16em] text-muted-foreground">
            Warrior Tracker
          </span>
        )}
        <span
          className={cn(
            "block truncate text-[15px] font-semibold leading-none tracking-[-0.015em] text-foreground",
            current && "mt-[6px]"
          )}
        >
          {workspace}
        </span>
      </span>
      {switchable && (
        <CaretDown
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-[transform,color] duration-200",
            "group-hover/ws:text-foreground/70 motion-reduce:transition-none",
            open && "rotate-180",
            collapsible && "group-data-[collapsible=icon]:hidden"
          )}
          weight="bold"
        />
      )}
    </>
  )

  const rowClass = cn(
    "group/ws flex items-center gap-2.5 rounded-lg p-1.5 transition-colors",
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
            // The hover is a fill of the panel's own accent step -- 11% on a
            // 6% sidebar in dark, 95.5% on white in light -- and no border at
            // all. It is the same fill the nav rows below take, which is what
            // makes the header read as the top of that list rather than as a
            // separate widget parked above it. The crest survives the hover
            // because its hairline, not its fill, is what draws it.
            collapsible
              ? "hover:bg-sidebar-accent data-[state=open]:bg-sidebar-accent"
              : "hover:bg-accent data-[state=open]:bg-accent",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
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
                  {/* The current team's tile is the one place the accent is
                      allowed here: it is state, not branding. Everything else
                      in the list takes the same quiet crest as the header. */}
                  <Avatar className="size-7 shrink-0 rounded-[6px]">
                    {team.logo_url && (
                      <AvatarImage src={team.logo_url} alt="" className="rounded-[6px]" />
                    )}
                    <AvatarFallback
                      className={cn(
                        "nav-mono rounded-[6px] text-[10px] font-bold",
                        isCurrent
                          ? "bg-[hsl(var(--nav-accent))] text-[hsl(var(--nav-accent-on))]"
                          : "bg-muted text-foreground/80 ring-1 ring-inset ring-border"
                      )}
                    >
                      {initials(team.name)}
                    </AvatarFallback>
                  </Avatar>
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
                      weight="bold"
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
