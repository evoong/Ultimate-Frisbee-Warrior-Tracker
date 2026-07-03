import {
  Zap,
  Calendar,
  Users,
  Award,
  BarChart3,
  MessageCircle,
  type LucideIcon,
} from "lucide-react"

export type Tab =
  | "quickscore"
  | "schedule"
  | "roster"
  | "ranking"
  | "stats"
  | "chat"

export const NAV_ITEMS: { key: Tab; label: string; icon: LucideIcon }[] = [
  { key: "quickscore", label: "Quick", icon: Zap },
  { key: "schedule", label: "Schedule", icon: Calendar },
  { key: "roster", label: "Roster", icon: Users },
  { key: "ranking", label: "Ranking", icon: Award },
  { key: "stats", label: "Stats", icon: BarChart3 },
  { key: "chat", label: "AI", icon: MessageCircle },
]
