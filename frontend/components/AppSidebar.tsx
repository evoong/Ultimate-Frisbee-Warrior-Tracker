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
import PanelToggle from "./nav/PanelToggle"

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
 * The active item is a 2px accent bar on the left edge, full ink and weight
 * 600 -- and nothing else. No fill.
 *
 * The wash that used to sit behind it was doing the same job twice: a tinted
 * block *and* a rail *and* a weight change, three signals for one bit of
 * state. Worse, a low-alpha tint of a deep accent is a muddy grey by the time
 * it lands, so the item read as "faintly shaded" rather than "selected", and
 * every nav item ended up wearing a slightly different background. One
 * high-contrast bar against a clean panel is louder than a fill and costs the
 * panel none of its calm -- it is why Linear and Vercel both mark the current
 * page this way.
 *
 * The glyph takes --nav-accent-ink and the label goes to full ink at weight
 * 600. Between them the row reads as active from three feet away without a
 * single pixel of background changing.
 *
 * Inactive items sit at 75% ink. The point of dimming them is to push them
 * back behind the active item, but they are still the primary navigation and
 * have to stay readable. In light mode --sidebar-foreground at 0.75 over
 * --sidebar-background lands at ~5.9:1; at 0.6 it falls under 4.5:1, which is
 * a contrast failure dressed up as hierarchy. Dark has far more headroom
 * (~8:1 at the same alpha), so one value covers both.
 *
 * The rail is drawn as a ::before *inside* the button rather than flush to
 * the sidebar's outer edge on purpose: the button carries `overflow-hidden`
 * from sidebarMenuButtonVariants and SidebarContent scrolls with
 * `overflow-auto`, so anything at a negative offset gets clipped by one or
 * the other and silently disappears.
 *
 * The `data-[active=true]` overrides below are not belt-and-braces --
 * sidebarMenuButtonVariants ships its own active fill, weight and colour, and
 * these are what tailwind-merge collapses them into.
 */
const NAV_ITEM_CLASS = cn(
  "relative h-9 rounded-md text-[13.5px] text-sidebar-foreground/75 transition-colors",
  "before:absolute before:left-0 before:top-1/2 before:h-0 before:w-[2px]",
  "before:-translate-y-1/2 before:rounded-r-full before:bg-[hsl(var(--nav-accent))]",
  "before:transition-[height] before:duration-200 before:ease-out before:content-['']",
  "motion-reduce:before:transition-none",
  "[&>svg]:text-sidebar-foreground/55 [&>svg]:transition-colors",
  "hover:bg-sidebar-accent hover:text-sidebar-foreground hover:[&>svg]:text-sidebar-foreground/80",
  "data-[active=true]:bg-transparent data-[active=true]:hover:bg-sidebar-accent",
  "data-[active=true]:font-semibold data-[active=true]:text-sidebar-foreground",
  "data-[active=true]:before:h-[1.125rem]",
  "data-[active=true]:[&>svg]:text-[hsl(var(--nav-accent-ink))]"
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
      {/* Workspace on the left, panel control on the right, both inside the
          panel's own top bar. Collapsed there is no room for a row, so the
          two stack and the toggle takes the top slot -- it is the only way
          back out once the labels are gone, so it must not be the thing that
          scrolls or hides. `order-first` rather than a second DOM order keeps
          the tab sequence identical in both states. */}
      <SidebarHeader className="p-2">
        <div className="flex items-center gap-1 group-data-[collapsible=icon]:flex-col">
          <div className="min-w-0 flex-1 group-data-[collapsible=icon]:flex-none">
            <WorkspaceSwitcher
              teams={teams}
              currentTeamId={currentTeamId}
              switchTeam={switchTeam}
            />
          </div>
          <PanelToggle className="group-data-[collapsible=icon]:order-first" />
        </div>
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
                    <Icon weight={activeTab === key ? "fill" : "regular"} />
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
