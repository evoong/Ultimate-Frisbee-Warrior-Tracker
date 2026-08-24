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

export function tabForPath(pathname: string): Tab {
  return NAV_ITEMS.find(item => item.path === pathname)?.key ?? "schedule"
}

export function pathForTab(tab: Tab): string {
  return NAV_ITEMS.find(item => item.key === tab)!.path
}
