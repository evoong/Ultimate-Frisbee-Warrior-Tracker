import { SidebarSimple } from "@phosphor-icons/react"
import { useSidebar } from "../../lib/shadcn/sidebar"
import { cn } from "../../lib/shadcn/utils"

/**
 * Collapse/expand for the rail, and the left half of the shell's utility
 * strip.
 *
 * The strip is what is left of the content header once the page title comes
 * out of it: the page now titles itself with a real <h1> at the top of its
 * own content, so the bar above holds nothing about the page at all. That
 * leaves exactly two controls -- one that acts on the panel, one that acts
 * on the theme -- parked at the two ends of a 48px strip, which is why the
 * toggle can sit here now without reading as page chrome. There is nothing
 * left beside it to be mistaken for.
 *
 * It is the only copy. A second one inside the rail's own header would be
 * two buttons doing one job in adjacent rows, and this one is at a fixed
 * point on screen in both states, which is what a control you use to get the
 * panel *back* has to be.
 *
 * It matches ThemeToggle exactly -- same 36px square, same 18px glyph, same
 * neutral ink -- because a strip of two icons is read as one instrument, and
 * mismatched sizes are the loudest tell that a toolbar was assembled rather
 * than designed.
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
        "grid size-9 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors",
        "hover:bg-accent hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        className
      )}
    >
      <SidebarSimple className="size-[18px]" weight="regular" />
    </button>
  )
}
