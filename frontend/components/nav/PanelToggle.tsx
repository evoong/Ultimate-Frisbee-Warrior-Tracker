import { PanelLeft } from "lucide-react"
import { useSidebar } from "../../lib/shadcn/sidebar"
import { cn } from "../../lib/shadcn/utils"

/**
 * Collapse/expand for the rail, living in the rail's own top bar next to the
 * workspace rather than in the content header.
 *
 * It is a control *of the panel*, so it belongs *to the panel*: parked beside
 * the page title it read as one more piece of page chrome, and it sat in the
 * one row where the sidebar and the content area are hardest to tell apart.
 * On the collapsed rail it stays put and becomes the way back out, which is
 * why it is the first thing in the header once the labels are gone.
 *
 * One glyph in both states, not a swap between open/close icons: the button
 * never moves and the panel beside it is visibly open or shut, so animating
 * the icon would only add a second thing to read. The accessible name carries
 * the state instead.
 *
 * Deliberately neutral ink, like ThemeToggle: --nav-accent means "you are
 * here" everywhere else in the shell, and a utility that is always available
 * has no active state to spend it on.
 */
export default function PanelToggle({ className }: { className?: string }) {
  const { state, toggleSidebar } = useSidebar()
  const expanded = state === "expanded"
  const label = expanded ? "Collapse sidebar" : "Expand sidebar"

  return (
    <button
      type="button"
      onClick={toggleSidebar}
      aria-label={label}
      aria-expanded={expanded}
      title={label}
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-md text-sidebar-foreground/75 transition-colors",
        "hover:bg-sidebar-accent hover:text-sidebar-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-1 focus-visible:ring-offset-sidebar",
        className
      )}
    >
      <PanelLeft className="size-[17px]" strokeWidth={1.75} />
    </button>
  )
}
