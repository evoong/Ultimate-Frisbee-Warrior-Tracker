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

export const NAV_ITEMS: { key: Tab; label: string; icon: LucideIcon }[] = [
  { key: "schedule", label: "Schedule", icon: Calendar },
  { key: "roster", label: "Roster", icon: Users },
  { key: "stats", label: "Stats", icon: BarChart3 },
  { key: "strategy", label: "Plays", icon: ClipboardList },
  { key: "chat", label: "AI", icon: MessageCircle },
]
