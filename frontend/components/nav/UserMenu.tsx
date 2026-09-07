import { useState, type ComponentType } from "react"
import { ChevronsUpDown, KeyRound, LogOut, Megaphone, Settings } from "lucide-react"
import type { TeamRole } from "../../lib/authClient"
import { Avatar, AvatarFallback } from "../../lib/shadcn/avatar"
import { Popover, PopoverContent, PopoverTrigger } from "../../lib/shadcn/popover"
import { cn } from "../../lib/shadcn/utils"
import { accountName, accountSubtitle, initials } from "./identity"

type UserMenuProps = {
  email: string | null
  role: TeamRole | null
  isGuest: boolean
  logout: () => void
  openSettings: () => void
  /** Absent when passkeys are unavailable on this deployment (see passkeys.ts). */
  openPasskeys?: () => void
  openFeedback: () => void
  /**
   * "sidebar" is the full card at the foot of the desktop rail. "bar" is the
   * avatar-only trigger in the mobile header, where there is no room for a
   * name and the header is already carrying the workspace on the other side.
   */
  variant?: "sidebar" | "bar"
}

type MenuAction = { icon: ComponentType<{ className?: string; strokeWidth?: number }>; label: string; onSelect: () => void }

/**
 * Everything that used to be a separate row in the sidebar footer -- the raw
 * email address, "Organization", "Passkeys", "Report a bug / idea" -- lives
 * here instead, behind one account card at the very bottom of the shell.
 *
 * The footer was four unrelated links stacked in a column, which is the shape
 * a boilerplate template leaves behind: each item read as equally important as
 * the navigation above it, and none of them are. Collapsing them under one
 * card puts the account where people already look for it and gives the
 * navigation back its own weight.
 *
 * The theme toggle deliberately does *not* live in here. It is a control
 * people flip often and idly, and burying a one-tap toggle two clicks deep is
 * worse than a row -- it sits with the utility icons in the header instead.
 */
export default function UserMenu({
  email,
  role,
  isGuest,
  logout,
  openSettings,
  openPasskeys,
  openFeedback,
  variant = "sidebar",
}: UserMenuProps) {
  const [open, setOpen] = useState(false)
  const name = accountName(email)
  const subtitle = accountSubtitle(role, isGuest)

  const actions: MenuAction[] = [
    // A guest holds no membership on the team they are browsing, so the
    // settings dialog would open in its own view-only state and offer them
    // nothing. Hiding it is what the database would do anyway.
    ...(isGuest ? [] : [{ icon: Settings, label: "Team settings", onSelect: openSettings }]),
    ...(openPasskeys ? [{ icon: KeyRound, label: "Passkeys", onSelect: openPasskeys }] : []),
    { icon: Megaphone, label: "Feedback", onSelect: openFeedback },
  ]

  const run = (fn: () => void) => () => {
    setOpen(false)
    fn()
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Account: ${name}`}
          className={cn(
            "flex items-center rounded-md transition-colors hover:bg-accent",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
            variant === "sidebar"
              ? "w-full gap-2.5 p-1.5 group-data-[collapsible=icon]:!p-1"
              : "p-1"
          )}
        >
          <Avatar className="size-8 shrink-0 rounded-[6px]">
            <AvatarFallback className="nav-mono rounded-[6px] bg-muted text-[10px] font-bold tracking-[0.04em] text-foreground/70">
              {initials(name)}
            </AvatarFallback>
          </Avatar>
          {variant === "sidebar" && (
            <>
              <span className="min-w-0 flex-1 text-left group-data-[collapsible=icon]:hidden">
                <span className="block truncate text-[13px] font-semibold leading-none">
                  {name}
                </span>
                <span className="nav-mono mt-[5px] block truncate text-[9px] uppercase leading-none tracking-[0.15em] text-muted-foreground">
                  {subtitle}
                </span>
              </span>
              <ChevronsUpDown
                className="size-3.5 shrink-0 text-muted-foreground group-data-[collapsible=icon]:hidden"
                strokeWidth={2}
              />
            </>
          )}
        </button>
      </PopoverTrigger>

      <PopoverContent
        side={variant === "bar" ? "bottom" : "right"}
        align="end"
        sideOffset={8}
        className="w-60 p-1.5"
      >
        <div className="flex items-center gap-2.5 px-2 py-2">
          <Avatar className="size-8 shrink-0 rounded-[6px]">
            <AvatarFallback className="nav-mono rounded-[6px] bg-muted text-[10px] font-bold tracking-[0.04em] text-foreground/70">
              {initials(name)}
            </AvatarFallback>
          </Avatar>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-semibold leading-tight">{name}</span>
            {/* The full address, kept but demoted: it is a detail you check,
                not a label you navigate by. */}
            <span className="nav-mono mt-0.5 block truncate text-[10px] leading-tight text-muted-foreground">
              {email ?? subtitle}
            </span>
          </span>
        </div>

        <div className="my-1 h-px bg-border" />

        <div className="flex flex-col">
          {actions.map(({ icon: Icon, label, onSelect }) => (
            <button
              key={label}
              type="button"
              onClick={run(onSelect)}
              className="flex w-full items-center gap-2.5 rounded-[5px] px-2 py-[7px] text-left text-[13px] text-foreground/85 transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:outline-none"
            >
              <Icon className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
              {label}
            </button>
          ))}
        </div>

        <div className="my-1 h-px bg-border" />

        <button
          type="button"
          onClick={run(logout)}
          className="flex w-full items-center gap-2.5 rounded-[5px] px-2 py-[7px] text-left text-[13px] text-destructive transition-colors hover:bg-destructive/10 focus-visible:bg-destructive/10 focus-visible:outline-none"
        >
          <LogOut className="size-4 shrink-0" strokeWidth={1.75} />
          Sign out
        </button>
      </PopoverContent>
    </Popover>
  )
}
