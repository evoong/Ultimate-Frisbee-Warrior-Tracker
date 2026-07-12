import { Disc, Moon, Sun, LogOut, KeyRound, Settings } from "lucide-react"
import { NAV_ITEMS, type Tab } from "../lib/nav"
import type { OrgMembership } from "../lib/authClient"
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../lib/shadcn/select"

type AppSidebarProps = {
  activeTab: Tab
  setActiveTab: (tab: Tab) => void
  theme: "light" | "dark"
  toggleTheme: () => void
  userEmail: string
  logout: () => void
  organizations: OrgMembership[]
  currentOrgId: number | null
  switchOrg: (organizationId: number) => void
  openSettings: () => void
  // Absent when passkeys are unavailable on this deployment (see passkeys.ts).
  openPasskeys?: () => void
}

export default function AppSidebar({
  activeTab,
  setActiveTab,
  theme,
  toggleTheme,
  userEmail,
  logout,
  organizations,
  currentOrgId,
  switchOrg,
  openSettings,
  openPasskeys,
}: AppSidebarProps) {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" className="pointer-events-none">
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                <Disc className="size-4" />
              </div>
              <div className="grid flex-1 text-left leading-tight">
                <span className="truncate font-bold">Warrior Tracker</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {organizations.length > 1 && (
            <SidebarMenuItem>
              <Select value={currentOrgId != null ? String(currentOrgId) : undefined} onValueChange={v => switchOrg(Number(v))}>
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {organizations.map(o => (
                    <SelectItem key={o.organization_id} value={String(o.organization_id)}>{o.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SidebarMenuItem>
          )}
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.map(({ key, label, icon: Icon }) => (
                <SidebarMenuItem key={key}>
                  <SidebarMenuButton
                    isActive={activeTab === key}
                    onClick={() => setActiveTab(key)}
                    tooltip={label}
                  >
                    <Icon />
                    <span>{label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={toggleTheme} tooltip="Toggle theme">
              {theme === "dark" ? <Sun /> : <Moon />}
              <span>{theme === "dark" ? "Light mode" : "Dark mode"}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={openSettings} tooltip="Organization settings">
              <Settings />
              <span>Organization</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {openPasskeys && (
            <SidebarMenuItem>
              <SidebarMenuButton onClick={openPasskeys} tooltip="Manage passkeys">
                <KeyRound />
                <span>Passkeys</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          <SidebarMenuItem>
            <SidebarMenuButton onClick={() => logout()} tooltip={userEmail}>
              <LogOut />
              <span className="truncate">{userEmail}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  )
}
