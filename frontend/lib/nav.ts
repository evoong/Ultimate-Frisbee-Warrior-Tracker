import {
  Calendar,
  Users,
  BarChart3,
  ClipboardList,
  MessageCircle,
  type LucideIcon,
} from "lucide-react"

export type Tab =
  | "schedule"
  | "roster"
  | "stats"
  | "strategy"
  | "chat"

// Each tab is also a real URL, so the browser's back/forward buttons (and
// reloading, bookmarking, or sharing a link) land on the right page instead
// of always resetting to the default 'schedule' tab. Paths use the same
// user-facing names as the label ("Plays"/"AI"), not the internal Tab key,
// since those are what a URL a person actually reads should say.
export const NAV_ITEMS: { key: Tab; label: string; icon: LucideIcon; path: string }[] = [
  { key: "schedule", label: "Schedule", icon: Calendar, path: "/schedule" },
  { key: "roster", label: "Roster", icon: Users, path: "/roster" },
  { key: "stats", label: "Stats", icon: BarChart3, path: "/stats" },
  { key: "strategy", label: "Plays", icon: ClipboardList, path: "/plays" },
  { key: "chat", label: "AI", icon: MessageCircle, path: "/ai" },
]

// Matches a tab's own path exactly, or a sub-path under it (e.g.
// "/schedule/42", a deep link to one game's detail view), so a tab still
// reads as active while viewing a specific game/player/play/stats sub-tab
// within it, not just at its bare path.
function pathMatches(itemPath: string, pathname: string): boolean {
  return pathname === itemPath || pathname.startsWith(itemPath + "/")
}

// Plays and AI read strategy_* and chat_logs, which are members-only with no
// public branch at all. Hiding them for guests matches what the database
// will do anyway.
const MEMBER_ONLY_TABS: Tab[] = ['strategy', 'chat']

export function visibleNavItems(isGuest: boolean) {
  return isGuest ? NAV_ITEMS.filter(i => !MEMBER_ONLY_TABS.includes(i.key)) : NAV_ITEMS
}

export function tabForPath(pathname: string): Tab {
  return NAV_ITEMS.find(item => pathMatches(item.path, pathname))?.key ?? "schedule"
}

export function pathForTab(tab: Tab): string {
  return NAV_ITEMS.find(item => item.key === tab)!.path
}

// Whether pathname falls under one of the app's real tabs (its own path or
// a sub-path), used to decide whether an unrecognized URL should redirect
// to the default tab instead of being treated as a deep link.
export function isKnownPath(pathname: string): boolean {
  return NAV_ITEMS.some(item => pathMatches(item.path, pathname))
}
