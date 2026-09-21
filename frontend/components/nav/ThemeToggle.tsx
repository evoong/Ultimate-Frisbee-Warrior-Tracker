import { Moon, Sun } from "@phosphor-icons/react"
import { cn } from "../../lib/shadcn/utils"

type ThemeToggleProps = {
  theme: "light" | "dark"
  toggleTheme: () => void
  className?: string
}

/**
 * A sun/moon square, not a labelled row. "Light mode" spent a full navigation
 * slot -- the same visual weight as Schedule or Roster -- on a control whose
 * entire meaning is carried by its glyph, and put it next to items that
 * change what page you are on, which this does not.
 *
 * It lives with the header's utility icons in both layouts so there is one
 * place to look for it regardless of viewport.
 */
export default function ThemeToggle({ theme, toggleTheme, className }: ThemeToggleProps) {
  const next = theme === "dark" ? "light" : "dark"
  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      className={cn(
        "grid size-9 place-items-center rounded-md text-muted-foreground transition-colors",
        "hover:bg-accent hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        className
      )}
    >
      {theme === "dark" ? (
        <Sun className="size-[18px]" weight="regular" />
      ) : (
        <Moon className="size-[18px]" weight="regular" />
      )}
    </button>
  )
}
