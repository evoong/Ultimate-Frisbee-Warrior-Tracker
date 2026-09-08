import {
  CalendarBlank,
  UsersThree,
  ChartBar,
  BookOpen,
  ChatCircleDots,
  type Icon,
} from "@phosphor-icons/react"

export type Tab =
  | "schedule"
  | "roster"
  | "stats"
  | "strategy"
  | "chat"

// Each tab is also a real URL, so the browser's back/forward buttons (and
// reloading, bookmarking, or sharing a link) land on the right page instead
// of always resetting to the default 'schedule' tab. Paths use the same
// user-facing names as the label ("Playbook"/"Coach"), not the internal Tab
// key, since those are what a URL a person actually reads should say.
//
// "Playbook" over "Plays", and "Coach" over "AI": a nav label is where an app
// says what it is for. "AI" named the implementation, not the job -- every
// product has an API wrapper behind some tab -- while "Coach" names what the
// thing actually does for a team. "Playbook" reads as a curated collection
// rather than a list of rows. Renaming the labels without renaming the paths
// would have left /plays and /ai as the two URLs nobody could guess.
export const NAV_ITEMS: { key: Tab; label: string; icon: Icon; path: string }[] = [
  { key: "schedule", label: "Schedule", icon: CalendarBlank, path: "/schedule" },
  { key: "roster", label: "Roster", icon: UsersThree, path: "/roster" },
  { key: "stats", label: "Stats", icon: ChartBar, path: "/stats" },
  { key: "strategy", label: "Playbook", icon: BookOpen, path: "/playbook" },
  { key: "chat", label: "Coach", icon: ChatCircleDots, path: "/coach" },
]

// The paths those two tabs used to live at. Anything already bookmarked,
// shared in a group chat, or sitting in someone's history under the old name
// still has to land on the real page: without this, App's unknown-path effect
// would silently bounce every one of those links to /schedule. Sub-paths are
// carried across too, so /plays/42 becomes /playbook/42 rather than the
// playbook index.
const RENAMED_PATHS: [from: string, to: string][] = [
  ["/plays", "/playbook"],
  ["/ai", "/coach"],
]

/**
 * The current path for a URL that used a tab's old name, or null if the
 * pathname is not one of those. Callers redirect (replace, not push -- the
 * old URL should not be a back-button stop).
 */
export function renamedPathFor(pathname: string): string | null {
  for (const [from, to] of RENAMED_PATHS) {
    if (pathname === from || pathname.startsWith(from + "/")) {
      return to + pathname.slice(from.length)
    }
  }
  return null
}

// Matches a tab's own path exactly, or a sub-path under it (e.g.
// "/schedule/42", a deep link to one game's detail view), so a tab still
// reads as active while viewing a specific game/player/play/stats sub-tab
// within it, not just at its bare path.
function pathMatches(itemPath: string, pathname: string): boolean {
  return pathname === itemPath || pathname.startsWith(itemPath + "/")
}

// Playbook and Coach read strategy_* and chat_logs, which are members-only
// with no public branch at all. Hiding them for guests matches what the
// database will do anyway.
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

// Real routes that exist in the app but aren't nav tabs, so they must not
// appear in NAV_ITEMS (that would put them in the sidebar / bottom nav).
// /teams is the guest public-teams browser (see PublicTeams.tsx / App.tsx).
const EXTRA_KNOWN_PATHS = ["/teams"]

// Whether pathname falls under one of the app's real tabs (its own path or
// a sub-path), used to decide whether an unrecognized URL should redirect
// to the default tab instead of being treated as a deep link.
export function isKnownPath(pathname: string): boolean {
  return (
    NAV_ITEMS.some(item => pathMatches(item.path, pathname)) ||
    EXTRA_KNOWN_PATHS.some(path => pathMatches(path, pathname))
  )
}
