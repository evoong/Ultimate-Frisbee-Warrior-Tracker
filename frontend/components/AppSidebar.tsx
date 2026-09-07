import { visibleNavItems, type Tab } from "../lib/nav"
import type { TeamMembership, TeamRole } from "../lib/authClient"
import {
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarRail,
} from "../lib/shadcn/sidebar"
import { cn } from "../lib/shadcn/utils"
import WorkspaceSwitcher from "./nav/WorkspaceSwitcher"
import UserMenu from "./nav/UserMenu"

type AppSidebarProps = {
  activeTab: Tab
  setActiveTab: (tab: Tab) => void
  userEmail: string | null
  role: TeamRole | null
  logout: () => void
  teams: TeamMembership[]
  currentTeamId: number | null
  switchTeam: (teamId: number) => void
  isGuest: boolean
  openSettings: () => void
  // Absent when passkeys are unavailable on this deployment (see passkeys.ts).
  openPasskeys?: () => void
  openFeedback: () => void
}

/**
 * The active item carries a 3px chartreuse rail on its left edge on top of a
 * wash of the same colour, and steps up to weight 600 at full ink. Inactive
 * items sit at 75% ink.
 *
 * 75%, specifically: the point of dimming them is to push them back behind
 * the active item, but they are still the primary navigation and have to stay
 * readable. In light mode --sidebar-foreground at 0.75 over --sidebar-background
 * lands at ~4.8:1, just clear of the 4.5:1 floor; at 0.6 it falls to ~3.2:1,
 * which is a contrast failure dressed up as hierarchy. Dark mode has far more
 * headroom (~8:1 at the same alpha), so one value works for both.
 *
 * The rail is drawn as a ::before *inside* the button rather than flush to the
 * sidebar's outer edge on purpose: the button carries `overflow-hidden` from
 * sidebarMenuButtonVariants and SidebarContent scrolls with `overflow-auto`,
 * so anything at a negative offset gets clipped by one or the other.
 */
const NAV_ITEM_CLASS = cn(
  "relative h-9 rounded-md text-sidebar-foreground/75 transition-colors",
  "before:absolute before:left-0 before:top-1/2 before:h-0 before:w-[3px]",
  "before:-translate-y-1/2 before:rounded-r-full before:bg-[hsl(var(--nav-accent))]",
  "before:transition-[height] before:duration-200 before:ease-out before:content-['']",
  "motion-reduce:before:transition-none",
  "[&>svg]:text-sidebar-foreground/60 [&>svg]:transition-colors",
  "hover:bg-sidebar-accent hover:text-sidebar-foreground hover:[&>svg]:text-sidebar-foreground/80",
  "data-[active=true]:bg-[hsl(var(--nav-accent)/0.11)]",
  "data-[active=true]:font-semibold data-[active=true]:text-sidebar-foreground",
  "data-[active=true]:before:h-5",
  "data-[active=true]:[&>svg]:text-[hsl(var(--nav-accent-ink))]",
  "data-[active=true]:hover:bg-[hsl(var(--nav-accent)/0.16)]"
)

export default function AppSidebar({
  activeTab,
  setActiveTab,
  userEmail,
  role,
  logout,
  teams,
  currentTeamId,
  switchTeam,
  isGuest,
  openSettings,
  openPasskeys,
  openFeedback,
}: AppSidebarProps) {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="p-2">
        <WorkspaceSwitcher
          teams={teams}
          currentTeamId={currentTeamId}
          switchTeam={switchTeam}
        />
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              {visibleNavItems(isGuest).map(({ key, label, icon: Icon }) => (
                <SidebarMenuItem key={key}>
                  <SidebarMenuButton
                    isActive={activeTab === key}
                    onClick={() => setActiveTab(key)}
                    tooltip={label}
                    className={NAV_ITEM_CLASS}
                  >
                    <Icon strokeWidth={1.75} />
                    <span>{label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      {/* One card, at the absolute bottom. Everything that used to be a
          separate footer row lives inside its menu -- see UserMenu. */}
      <SidebarFooter className="border-t border-sidebar-border p-2">
        <UserMenu
          email={userEmail}
          role={role}
          isGuest={isGuest}
          logout={logout}
          openSettings={openSettings}
          openPasskeys={openPasskeys}
          openFeedback={openFeedback}
        />
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  )
}
