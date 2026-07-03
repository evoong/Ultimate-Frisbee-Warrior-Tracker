# Desktop Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give desktop (>= 1024px) a collapsible shadcn Sidebar shell for navigation while keeping the existing mobile bottom-nav layout unchanged, both driven by one shared nav config and the same active-tab state.

**Architecture:** Add the shadcn Sidebar primitive (Tailwind-v3 variant) and its dependencies to `frontend/lib/shadcn/`. Extract nav items into a shared `frontend/lib/nav.ts`. A media-query hook selects, in `App.tsx`, between the desktop sidebar shell (`SidebarProvider` + `AppSidebar` + `SidebarInset`) and the current mobile shell (header + fixed bottom nav). Page content renders once; only the surrounding shell differs.

**Tech Stack:** React 19 + TypeScript, Vite, Tailwind CSS v3.4.19, shadcn/Radix UI (dialog, tooltip, separator, slot already installed), `class-variance-authority`, lucide-react.

## Global Constraints

- No new npm dependencies. All Radix deps used here (dialog, tooltip, separator, slot) and `class-variance-authority` are already in `frontend/package.json`.
- Tailwind is **v3.4.19**. Use v3 class syntax: `w-[--sidebar-width]` bracket form and color classes like `bg-sidebar`, `text-sidebar-foreground` resolved via `tailwind.config.js`. Do NOT use Tailwind v4 syntax (`w-(--sidebar-width)`, `bg-sidebar/50` arbitrary theme functions).
- shadcn primitives live in `frontend/lib/shadcn/` (NOT `components/ui`). There is no `components.json`; add files manually. `cn` is imported from `./utils`. Match the existing primitive style in `frontend/lib/shadcn/dialog.tsx` (relative imports, `React.forwardRef`, `displayName`).
- Docs style rule (CLAUDE.md): no em dashes, no emojis in any prose/comments.
- Desktop breakpoint is **1024px** (`lg`). Sidebar shell mounts only at or above it.
- Mobile layout, bottom nav, and all page internals must stay behavior-identical. No React Router; keep the tab-state model.
- There is no frontend test runner (`npm test` is backend-only). The verification gate for each task is: `cd frontend && npx tsc --noEmit` shows no errors referencing the files you created or modified (several pre-existing errors in `pages/*` are unrelated and expected), plus, for the final task, `npm run build` and a manual browser check.

---

### Task 1: Add sidebar theme tokens

**Files:**
- Modify: `frontend/index.css` (add `--sidebar-*` variables to `:root` and `.dark`)
- Modify: `frontend/tailwind.config.js` (add `sidebar` color group)

Note: `frontend/orgTheme.css` is not imported anywhere (only `index.css` is imported, in `main.tsx`), so it is dormant and intentionally left untouched.

**Interfaces:**
- Produces: Tailwind color utilities `bg-sidebar`, `text-sidebar-foreground`, `bg-sidebar-primary`, `text-sidebar-primary-foreground`, `bg-sidebar-accent`, `text-sidebar-accent-foreground`, `border-sidebar-border`, `ring-sidebar-ring`, `bg-sidebar-border`. These are consumed by `sidebar.tsx` (Task 3).

- [ ] **Step 1: Add `--sidebar-*` variables to `index.css`**

In `frontend/index.css`, inside the `:root` block, add these lines immediately after `--radius: 0.5rem;` (before the closing `}` of `:root`):

```css
    --sidebar-background: 0 0% 98%;
    --sidebar-foreground: 240 5.3% 26.1%;
    --sidebar-primary: 240 5.9% 10%;
    --sidebar-primary-foreground: 0 0% 98%;
    --sidebar-accent: 240 4.8% 95.9%;
    --sidebar-accent-foreground: 240 5.9% 10%;
    --sidebar-border: 220 13% 91%;
    --sidebar-ring: 217.2 91.2% 59.8%;
```

Inside the `.dark` block, add these lines immediately after `--ring: 0 0% 98%;` (before the closing `}` of `.dark`):

```css
    --sidebar-background: 240 3.7% 15.9%;
    --sidebar-foreground: 240 4.8% 95.9%;
    --sidebar-primary: 0 0% 98%;
    --sidebar-primary-foreground: 240 5.9% 10%;
    --sidebar-accent: 240 3.7% 20%;
    --sidebar-accent-foreground: 240 4.8% 95.9%;
    --sidebar-border: 240 3.7% 20%;
    --sidebar-ring: 217.2 91.2% 59.8%;
```

(The dark `--sidebar-background` uses the card color `240 3.7% 15.9%` so the sidebar reads as a panel against the `240 5.9% 10%` page background.)

- [ ] **Step 2: Add the `sidebar` color group to `tailwind.config.js`**

In `frontend/tailwind.config.js`, inside `theme.extend.colors`, add this entry immediately after the `card: { ... },` block (before the closing `}` of `colors`):

```js
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
```

- [ ] **Step 3: Verify the build still compiles the CSS**

Run: `cd frontend && npx tsc --noEmit`
Expected: no NEW errors (pre-existing `pages/*` errors may appear; none should reference `index.css` or `tailwind.config.js`).

- [ ] **Step 4: Commit**

```bash
git add frontend/index.css frontend/tailwind.config.js
git commit -m "Add sidebar theme tokens and Tailwind color group"
```

---

### Task 2: Add sidebar primitive dependencies (sheet, tooltip, separator, use-mobile)

**Files:**
- Create: `frontend/lib/shadcn/sheet.tsx`
- Create: `frontend/lib/shadcn/tooltip.tsx`
- Create: `frontend/lib/shadcn/separator.tsx`
- Create: `frontend/lib/shadcn/use-mobile.ts`

**Interfaces:**
- Produces (consumed by `sidebar.tsx` in Task 3):
  - `sheet.tsx`: `Sheet`, `SheetContent` (and `SheetTrigger`, `SheetClose`, `SheetHeader`, `SheetFooter`, `SheetTitle`, `SheetDescription`).
  - `tooltip.tsx`: `Tooltip`, `TooltipTrigger`, `TooltipContent`, `TooltipProvider`.
  - `separator.tsx`: `Separator`.
  - `use-mobile.ts`: `useIsMobile(): boolean` (true below 768px).

- [ ] **Step 1: Create `frontend/lib/shadcn/use-mobile.ts`**

```ts
import * as React from "react"

const MOBILE_BREAKPOINT = 768

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    }
    mql.addEventListener("change", onChange)
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return !!isMobile
}
```

- [ ] **Step 2: Create `frontend/lib/shadcn/separator.tsx`**

```tsx
import * as React from "react"
import * as SeparatorPrimitive from "@radix-ui/react-separator"

import { cn } from "./utils"

const Separator = React.forwardRef<
  React.ElementRef<typeof SeparatorPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>
>(
  (
    { className, orientation = "horizontal", decorative = true, ...props },
    ref
  ) => (
    <SeparatorPrimitive.Root
      ref={ref}
      decorative={decorative}
      orientation={orientation}
      className={cn(
        "shrink-0 bg-border",
        orientation === "horizontal" ? "h-[1px] w-full" : "h-full w-[1px]",
        className
      )}
      {...props}
    />
  )
)
Separator.displayName = SeparatorPrimitive.Root.displayName

export { Separator }
```

- [ ] **Step 3: Create `frontend/lib/shadcn/tooltip.tsx`**

```tsx
import * as React from "react"
import * as TooltipPrimitive from "@radix-ui/react-tooltip"

import { cn } from "./utils"

const TooltipProvider = TooltipPrimitive.Provider

const Tooltip = TooltipPrimitive.Root

const TooltipTrigger = TooltipPrimitive.Trigger

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-50 overflow-hidden rounded-md border bg-popover px-3 py-1.5 text-sm text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
        className
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
))
TooltipContent.displayName = TooltipPrimitive.Content.displayName

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
```

- [ ] **Step 4: Create `frontend/lib/shadcn/sheet.tsx`**

```tsx
import * as React from "react"
import * as SheetPrimitive from "@radix-ui/react-dialog"
import { cva, type VariantProps } from "class-variance-authority"
import { X } from "lucide-react"

import { cn } from "./utils"

const Sheet = SheetPrimitive.Root

const SheetTrigger = SheetPrimitive.Trigger

const SheetClose = SheetPrimitive.Close

const SheetPortal = SheetPrimitive.Portal

const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Overlay
    className={cn(
      "fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
    ref={ref}
  />
))
SheetOverlay.displayName = SheetPrimitive.Overlay.displayName

const sheetVariants = cva(
  "fixed z-50 gap-4 bg-background p-6 shadow-lg transition ease-in-out data-[state=closed]:duration-300 data-[state=open]:duration-500 data-[state=open]:animate-in data-[state=closed]:animate-out",
  {
    variants: {
      side: {
        top: "inset-x-0 top-0 border-b data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top",
        bottom:
          "inset-x-0 bottom-0 border-t data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",
        left: "inset-y-0 left-0 h-full w-3/4 border-r data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-sm",
        right:
          "inset-y-0 right-0 h-full w-3/4 border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-sm",
      },
    },
    defaultVariants: {
      side: "right",
    },
  }
)

interface SheetContentProps
  extends React.ComponentPropsWithoutRef<typeof SheetPrimitive.Content>,
    VariantProps<typeof sheetVariants> {}

const SheetContent = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Content>,
  SheetContentProps
>(({ side = "right", className, children, ...props }, ref) => (
  <SheetPortal>
    <SheetOverlay />
    <SheetPrimitive.Content
      ref={ref}
      className={cn(sheetVariants({ side }), className)}
      {...props}
    >
      {children}
      <SheetPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-secondary">
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </SheetPrimitive.Close>
    </SheetPrimitive.Content>
  </SheetPortal>
))
SheetContent.displayName = SheetPrimitive.Content.displayName

const SheetHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-2 text-center sm:text-left",
      className
    )}
    {...props}
  />
)
SheetHeader.displayName = "SheetHeader"

const SheetFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
      className
    )}
    {...props}
  />
)
SheetFooter.displayName = "SheetFooter"

const SheetTitle = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Title>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Title
    ref={ref}
    className={cn("text-lg font-semibold text-foreground", className)}
    {...props}
  />
))
SheetTitle.displayName = SheetPrimitive.Title.displayName

const SheetDescription = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Description>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
))
SheetDescription.displayName = SheetPrimitive.Description.displayName

export {
  Sheet,
  SheetPortal,
  SheetOverlay,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
}
```

- [ ] **Step 5: Verify typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors referencing `lib/shadcn/sheet.tsx`, `tooltip.tsx`, `separator.tsx`, or `use-mobile.ts`.

- [ ] **Step 6: Commit**

```bash
git add frontend/lib/shadcn/sheet.tsx frontend/lib/shadcn/tooltip.tsx frontend/lib/shadcn/separator.tsx frontend/lib/shadcn/use-mobile.ts
git commit -m "Add sheet, tooltip, separator primitives and useIsMobile hook"
```

---

### Task 3: Add the shadcn Sidebar primitive (Tailwind-v3 variant)

**Files:**
- Create: `frontend/lib/shadcn/sidebar.tsx`

**Interfaces:**
- Consumes (from Task 2): `useIsMobile` (`./use-mobile`), `Sheet`, `SheetContent` (`./sheet`), `Separator` (`./separator`), `Tooltip`, `TooltipContent`, `TooltipProvider`, `TooltipTrigger` (`./tooltip`). From existing files: `cn` (`./utils`), `Button` (`./button`), `Input` (`./input`), `Skeleton` (`./skeleton`).
- Produces (consumed by Tasks 5 and 6): `SidebarProvider`, `Sidebar`, `SidebarTrigger`, `SidebarRail`, `SidebarInset`, `SidebarHeader`, `SidebarFooter`, `SidebarContent`, `SidebarGroup`, `SidebarGroupContent`, `SidebarMenu`, `SidebarMenuItem`, `SidebarMenuButton`, `useSidebar`. `SidebarMenuButton` accepts `isActive?: boolean`, `tooltip?: string`, `size?`, and native button props including `onClick`.

- [ ] **Step 1: Create `frontend/lib/shadcn/sidebar.tsx`**

```tsx
import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { type VariantProps, cva } from "class-variance-authority"
import { PanelLeft } from "lucide-react"

import { cn } from "./utils"
import { useIsMobile } from "./use-mobile"
import { Button } from "./button"
import { Input } from "./input"
import { Separator } from "./separator"
import { Sheet, SheetContent } from "./sheet"
import { Skeleton } from "./skeleton"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip"

const SIDEBAR_COOKIE_NAME = "sidebar:state"
const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7
const SIDEBAR_WIDTH = "16rem"
const SIDEBAR_WIDTH_MOBILE = "18rem"
const SIDEBAR_WIDTH_ICON = "3rem"
const SIDEBAR_KEYBOARD_SHORTCUT = "b"

type SidebarContextProps = {
  state: "expanded" | "collapsed"
  open: boolean
  setOpen: (open: boolean) => void
  openMobile: boolean
  setOpenMobile: (open: boolean) => void
  isMobile: boolean
  toggleSidebar: () => void
}

const SidebarContext = React.createContext<SidebarContextProps | null>(null)

function useSidebar() {
  const context = React.useContext(SidebarContext)
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider.")
  }
  return context
}

const SidebarProvider = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div"> & {
    defaultOpen?: boolean
    open?: boolean
    onOpenChange?: (open: boolean) => void
  }
>(
  (
    {
      defaultOpen = true,
      open: openProp,
      onOpenChange: setOpenProp,
      className,
      style,
      children,
      ...props
    },
    ref
  ) => {
    const isMobile = useIsMobile()
    const [openMobile, setOpenMobile] = React.useState(false)

    const [_open, _setOpen] = React.useState(defaultOpen)
    const open = openProp ?? _open
    const setOpen = React.useCallback(
      (value: boolean | ((value: boolean) => boolean)) => {
        const openState = typeof value === "function" ? value(open) : value
        if (setOpenProp) {
          setOpenProp(openState)
        } else {
          _setOpen(openState)
        }

        document.cookie = `${SIDEBAR_COOKIE_NAME}=${openState}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`
      },
      [setOpenProp, open]
    )

    const toggleSidebar = React.useCallback(() => {
      return isMobile
        ? setOpenMobile((open) => !open)
        : setOpen((open) => !open)
    }, [isMobile, setOpen, setOpenMobile])

    React.useEffect(() => {
      const handleKeyDown = (event: KeyboardEvent) => {
        if (
          event.key === SIDEBAR_KEYBOARD_SHORTCUT &&
          (event.metaKey || event.ctrlKey)
        ) {
          event.preventDefault()
          toggleSidebar()
        }
      }

      window.addEventListener("keydown", handleKeyDown)
      return () => window.removeEventListener("keydown", handleKeyDown)
    }, [toggleSidebar])

    const state = open ? "expanded" : "collapsed"

    const contextValue = React.useMemo<SidebarContextProps>(
      () => ({
        state,
        open,
        setOpen,
        isMobile,
        openMobile,
        setOpenMobile,
        toggleSidebar,
      }),
      [state, open, setOpen, isMobile, openMobile, setOpenMobile, toggleSidebar]
    )

    return (
      <SidebarContext.Provider value={contextValue}>
        <TooltipProvider delayDuration={0}>
          <div
            style={
              {
                "--sidebar-width": SIDEBAR_WIDTH,
                "--sidebar-width-icon": SIDEBAR_WIDTH_ICON,
                ...style,
              } as React.CSSProperties
            }
            className={cn(
              "group/sidebar-wrapper flex min-h-svh w-full has-[[data-variant=inset]]:bg-sidebar",
              className
            )}
            ref={ref}
            {...props}
          >
            {children}
          </div>
        </TooltipProvider>
      </SidebarContext.Provider>
    )
  }
)
SidebarProvider.displayName = "SidebarProvider"

const Sidebar = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div"> & {
    side?: "left" | "right"
    variant?: "sidebar" | "floating" | "inset"
    collapsible?: "offcanvas" | "icon" | "none"
  }
>(
  (
    {
      side = "left",
      variant = "sidebar",
      collapsible = "offcanvas",
      className,
      children,
      ...props
    },
    ref
  ) => {
    const { isMobile, state, openMobile, setOpenMobile } = useSidebar()

    if (collapsible === "none") {
      return (
        <div
          className={cn(
            "flex h-full w-[--sidebar-width] flex-col bg-sidebar text-sidebar-foreground",
            className
          )}
          ref={ref}
          {...props}
        >
          {children}
        </div>
      )
    }

    if (isMobile) {
      return (
        <Sheet open={openMobile} onOpenChange={setOpenMobile} {...props}>
          <SheetContent
            data-sidebar="sidebar"
            data-mobile="true"
            className="w-[--sidebar-width] bg-sidebar p-0 text-sidebar-foreground [&>button]:hidden"
            style={
              {
                "--sidebar-width": SIDEBAR_WIDTH_MOBILE,
              } as React.CSSProperties
            }
            side={side}
          >
            <div className="flex h-full w-full flex-col">{children}</div>
          </SheetContent>
        </Sheet>
      )
    }

    return (
      <div
        ref={ref}
        className="group peer hidden md:block text-sidebar-foreground"
        data-state={state}
        data-collapsible={state === "collapsed" ? collapsible : ""}
        data-variant={variant}
        data-side={side}
      >
        <div
          className={cn(
            "duration-200 relative h-svh w-[--sidebar-width] bg-transparent transition-[width] ease-linear",
            "group-data-[collapsible=offcanvas]:w-0",
            "group-data-[side=right]:rotate-180",
            variant === "floating" || variant === "inset"
              ? "group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)_+_theme(spacing.4))]"
              : "group-data-[collapsible=icon]:w-[--sidebar-width-icon]"
          )}
        />
        <div
          className={cn(
            "duration-200 fixed inset-y-0 z-10 hidden h-svh w-[--sidebar-width] transition-[left,right,width] ease-linear md:flex",
            side === "left"
              ? "left-0 group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)]"
              : "right-0 group-data-[collapsible=offcanvas]:right-[calc(var(--sidebar-width)*-1)]",
            variant === "floating" || variant === "inset"
              ? "p-2 group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)_+_theme(spacing.4)_+2px)]"
              : "group-data-[collapsible=icon]:w-[--sidebar-width-icon] group-data-[side=left]:border-r group-data-[side=right]:border-l",
            className
          )}
          {...props}
        >
          <div
            data-sidebar="sidebar"
            className="flex h-full w-full flex-col bg-sidebar group-data-[variant=floating]:rounded-lg group-data-[variant=floating]:border group-data-[variant=floating]:border-sidebar-border group-data-[variant=floating]:shadow"
          >
            {children}
          </div>
        </div>
      </div>
    )
  }
)
Sidebar.displayName = "Sidebar"

const SidebarTrigger = React.forwardRef<
  React.ElementRef<typeof Button>,
  React.ComponentProps<typeof Button>
>(({ className, onClick, ...props }, ref) => {
  const { toggleSidebar } = useSidebar()

  return (
    <Button
      ref={ref}
      data-sidebar="trigger"
      variant="ghost"
      size="icon"
      className={cn("h-7 w-7", className)}
      onClick={(event) => {
        onClick?.(event)
        toggleSidebar()
      }}
      {...props}
    >
      <PanelLeft />
      <span className="sr-only">Toggle Sidebar</span>
    </Button>
  )
})
SidebarTrigger.displayName = "SidebarTrigger"

const SidebarRail = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<"button">
>(({ className, ...props }, ref) => {
  const { toggleSidebar } = useSidebar()

  return (
    <button
      ref={ref}
      data-sidebar="rail"
      aria-label="Toggle Sidebar"
      tabIndex={-1}
      onClick={toggleSidebar}
      title="Toggle Sidebar"
      className={cn(
        "absolute inset-y-0 z-20 hidden w-4 -translate-x-1/2 transition-all ease-linear after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] hover:after:bg-sidebar-border group-data-[side=left]:-right-4 group-data-[side=right]:left-0 sm:flex",
        "[[data-side=left]_&]:cursor-w-resize [[data-side=right]_&]:cursor-e-resize",
        "[[data-side=left][data-state=collapsed]_&]:cursor-e-resize [[data-side=right][data-state=collapsed]_&]:cursor-w-resize",
        "group-data-[collapsible=offcanvas]:translate-x-0 group-data-[collapsible=offcanvas]:after:left-full group-data-[collapsible=offcanvas]:hover:bg-sidebar",
        "[[data-side=left][data-collapsible=offcanvas]_&]:-right-2",
        "[[data-side=right][data-collapsible=offcanvas]_&]:-left-2",
        className
      )}
      {...props}
    />
  )
})
SidebarRail.displayName = "SidebarRail"

const SidebarInset = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"main">
>(({ className, ...props }, ref) => {
  return (
    <main
      ref={ref}
      className={cn(
        "relative flex min-h-svh flex-1 flex-col bg-background",
        "peer-data-[variant=inset]:min-h-[calc(100svh-theme(spacing.4))] md:peer-data-[variant=inset]:m-2 md:peer-data-[state=collapsed]:peer-data-[variant=inset]:ml-2 md:peer-data-[variant=inset]:ml-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow",
        className
      )}
      {...props}
    />
  )
})
SidebarInset.displayName = "SidebarInset"

const SidebarInput = React.forwardRef<
  React.ElementRef<typeof Input>,
  React.ComponentProps<typeof Input>
>(({ className, ...props }, ref) => {
  return (
    <Input
      ref={ref}
      data-sidebar="input"
      className={cn(
        "h-8 w-full bg-background shadow-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
        className
      )}
      {...props}
    />
  )
})
SidebarInput.displayName = "SidebarInput"

const SidebarHeader = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div">
>(({ className, ...props }, ref) => {
  return (
    <div
      ref={ref}
      data-sidebar="header"
      className={cn("flex flex-col gap-2 p-2", className)}
      {...props}
    />
  )
})
SidebarHeader.displayName = "SidebarHeader"

const SidebarFooter = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div">
>(({ className, ...props }, ref) => {
  return (
    <div
      ref={ref}
      data-sidebar="footer"
      className={cn("flex flex-col gap-2 p-2", className)}
      {...props}
    />
  )
})
SidebarFooter.displayName = "SidebarFooter"

const SidebarSeparator = React.forwardRef<
  React.ElementRef<typeof Separator>,
  React.ComponentProps<typeof Separator>
>(({ className, ...props }, ref) => {
  return (
    <Separator
      ref={ref}
      data-sidebar="separator"
      className={cn("mx-2 w-auto bg-sidebar-border", className)}
      {...props}
    />
  )
})
SidebarSeparator.displayName = "SidebarSeparator"

const SidebarContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div">
>(({ className, ...props }, ref) => {
  return (
    <div
      ref={ref}
      data-sidebar="content"
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-2 overflow-auto group-data-[collapsible=icon]:overflow-hidden",
        className
      )}
      {...props}
    />
  )
})
SidebarContent.displayName = "SidebarContent"

const SidebarGroup = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div">
>(({ className, ...props }, ref) => {
  return (
    <div
      ref={ref}
      data-sidebar="group"
      className={cn("relative flex w-full min-w-0 flex-col p-2", className)}
      {...props}
    />
  )
})
SidebarGroup.displayName = "SidebarGroup"

const SidebarGroupLabel = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div"> & { asChild?: boolean }
>(({ className, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : "div"

  return (
    <Comp
      ref={ref}
      data-sidebar="group-label"
      className={cn(
        "duration-200 flex h-8 shrink-0 items-center rounded-md px-2 text-xs font-medium text-sidebar-foreground/70 outline-none ring-sidebar-ring transition-[margin,opacity] ease-linear focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0",
        "group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0",
        className
      )}
      {...props}
    />
  )
})
SidebarGroupLabel.displayName = "SidebarGroupLabel"

const SidebarGroupContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div">
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-sidebar="group-content"
    className={cn("w-full text-sm", className)}
    {...props}
  />
))
SidebarGroupContent.displayName = "SidebarGroupContent"

const SidebarMenu = React.forwardRef<
  HTMLUListElement,
  React.ComponentProps<"ul">
>(({ className, ...props }, ref) => (
  <ul
    ref={ref}
    data-sidebar="menu"
    className={cn("flex w-full min-w-0 flex-col gap-1", className)}
    {...props}
  />
))
SidebarMenu.displayName = "SidebarMenu"

const SidebarMenuItem = React.forwardRef<
  HTMLLIElement,
  React.ComponentProps<"li">
>(({ className, ...props }, ref) => (
  <li
    ref={ref}
    data-sidebar="menu-item"
    className={cn("group/menu-item relative", className)}
    {...props}
  />
))
SidebarMenuItem.displayName = "SidebarMenuItem"

const sidebarMenuButtonVariants = cva(
  "peer/menu-button flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm outline-none ring-sidebar-ring transition-[width,height,padding] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 group-has-[[data-sidebar=menu-action]]/menu-item:pr-8 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground data-[state=open]:hover:bg-sidebar-accent data-[state=open]:hover:text-sidebar-accent-foreground group-data-[collapsible=icon]:!size-8 group-data-[collapsible=icon]:!p-2 [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        outline:
          "bg-background shadow-[0_0_0_1px_hsl(var(--sidebar-border))] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground hover:shadow-[0_0_0_1px_hsl(var(--sidebar-accent))]",
      },
      size: {
        default: "h-8 text-sm",
        sm: "h-7 text-xs",
        lg: "h-12 text-sm group-data-[collapsible=icon]:!p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

const SidebarMenuButton = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<"button"> & {
    asChild?: boolean
    isActive?: boolean
    tooltip?: string | React.ComponentProps<typeof TooltipContent>
  } & VariantProps<typeof sidebarMenuButtonVariants>
>(
  (
    {
      asChild = false,
      isActive = false,
      variant = "default",
      size = "default",
      tooltip,
      className,
      ...props
    },
    ref
  ) => {
    const Comp = asChild ? Slot : "button"
    const { isMobile, state } = useSidebar()

    const button = (
      <Comp
        ref={ref}
        data-sidebar="menu-button"
        data-size={size}
        data-active={isActive}
        className={cn(sidebarMenuButtonVariants({ variant, size }), className)}
        {...props}
      />
    )

    if (!tooltip) {
      return button
    }

    if (typeof tooltip === "string") {
      tooltip = {
        children: tooltip,
      }
    }

    return (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent
          side="right"
          align="center"
          hidden={state !== "collapsed" || isMobile}
          {...tooltip}
        />
      </Tooltip>
    )
  }
)
SidebarMenuButton.displayName = "SidebarMenuButton"

const SidebarMenuSkeleton = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div"> & {
    showIcon?: boolean
  }
>(({ className, showIcon = false, ...props }, ref) => {
  const width = React.useMemo(() => {
    return `${Math.floor(50)}%`
  }, [])

  return (
    <div
      ref={ref}
      data-sidebar="menu-skeleton"
      className={cn("rounded-md h-8 flex gap-2 px-2 items-center", className)}
      {...props}
    >
      {showIcon && (
        <Skeleton
          className="size-4 rounded-md"
          data-sidebar="menu-skeleton-icon"
        />
      )}
      <Skeleton
        className="h-4 flex-1 max-w-[--skeleton-width]"
        data-sidebar="menu-skeleton-text"
        style={
          {
            "--skeleton-width": width,
          } as React.CSSProperties
        }
      />
    </div>
  )
})
SidebarMenuSkeleton.displayName = "SidebarMenuSkeleton"

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
}
```

- [ ] **Step 2: Verify typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors referencing `lib/shadcn/sidebar.tsx`.

- [ ] **Step 3: Commit**

```bash
git add frontend/lib/shadcn/sidebar.tsx
git commit -m "Add shadcn Sidebar primitive (Tailwind v3 variant)"
```

---

### Task 4: Add shared nav config and the desktop media-query hook

**Files:**
- Create: `frontend/lib/nav.ts`
- Create: `frontend/lib/shadcn/use-media-query.ts`

**Interfaces:**
- Produces:
  - `nav.ts`: `type Tab = 'quickscore' | 'schedule' | 'roster' | 'ranking' | 'stats' | 'chat'` and `NAV_ITEMS: { key: Tab; label: string; icon: LucideIcon }[]` (6 items, in display order). Consumed by `App.tsx` (Task 6) and `AppSidebar.tsx` (Task 5).
  - `use-media-query.ts`: `useMediaQuery(query: string): boolean`. Consumed by `App.tsx` (Task 6).

- [ ] **Step 1: Create `frontend/lib/nav.ts`**

```ts
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
```

- [ ] **Step 2: Create `frontend/lib/shadcn/use-media-query.ts`**

```ts
import * as React from "react"

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = React.useState<boolean>(() =>
    typeof window !== "undefined" ? window.matchMedia(query).matches : false
  )

  React.useEffect(() => {
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    onChange()
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [query])

  return matches
}
```

- [ ] **Step 3: Verify typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors referencing `lib/nav.ts` or `lib/shadcn/use-media-query.ts`.

- [ ] **Step 4: Commit**

```bash
git add frontend/lib/nav.ts frontend/lib/shadcn/use-media-query.ts
git commit -m "Add shared nav config and useMediaQuery hook"
```

---

### Task 5: Build the AppSidebar component

**Files:**
- Create: `frontend/components/AppSidebar.tsx`

**Interfaces:**
- Consumes: `NAV_ITEMS`, `Tab` (`../lib/nav`); `Sidebar`, `SidebarHeader`, `SidebarContent`, `SidebarFooter`, `SidebarGroup`, `SidebarGroupContent`, `SidebarMenu`, `SidebarMenuItem`, `SidebarMenuButton`, `SidebarRail` (`../lib/shadcn/sidebar`).
- Produces: default export `AppSidebar` with props:
  ```ts
  type AppSidebarProps = {
    activeTab: Tab
    setActiveTab: (tab: Tab) => void
    theme: "light" | "dark"
    toggleTheme: () => void
    userEmail: string
    logout: () => void
  }
  ```
  Consumed by `App.tsx` (Task 6).

- [ ] **Step 1: Create `frontend/components/AppSidebar.tsx`**

```tsx
import { Disc, Moon, Sun, LogOut } from "lucide-react"
import { NAV_ITEMS, type Tab } from "../lib/nav"
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

type AppSidebarProps = {
  activeTab: Tab
  setActiveTab: (tab: Tab) => void
  theme: "light" | "dark"
  toggleTheme: () => void
  userEmail: string
  logout: () => void
}

export default function AppSidebar({
  activeTab,
  setActiveTab,
  theme,
  toggleTheme,
  userEmail,
  logout,
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
```

- [ ] **Step 2: Verify typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors referencing `components/AppSidebar.tsx`.

- [ ] **Step 3: Commit**

```bash
git add frontend/components/AppSidebar.tsx
git commit -m "Add AppSidebar desktop navigation component"
```

---

### Task 6: Wire the two shells into App.tsx

**Files:**
- Modify: `frontend/App.tsx`

**Interfaces:**
- Consumes: `NAV_ITEMS`, `Tab` (`./lib/nav`); `useMediaQuery` (`./lib/shadcn/use-media-query`); `SidebarProvider`, `SidebarInset`, `SidebarTrigger` (`./lib/shadcn/sidebar`); `AppSidebar` (`./components/AppSidebar`).

This task rewrites `App.tsx`. Below is the full target file. The header/theme/logout/loading/reset-password/login logic is preserved; the mobile shell is unchanged except that its bottom nav now maps `NAV_ITEMS`; a desktop shell is added and selected by `useMediaQuery`.

- [ ] **Step 1: Replace the contents of `frontend/App.tsx`**

```tsx
import { useEffect, useState } from 'react'
import Schedule from './pages/Schedule'
import Roster from './pages/Roster'
import QuickScore from './pages/QuickScore'
import Ranking from './pages/Ranking'
import Stats from './pages/Stats'
import Chat from './pages/Chat'
import Login from './pages/Login'
import ResetPassword from './pages/ResetPassword'
import { useAuth } from './contexts/AuthContext'
import { Moon, Sun, Loader2, LogOut } from 'lucide-react'
import { NAV_ITEMS, type Tab } from './lib/nav'
import { useMediaQuery } from './lib/shadcn/use-media-query'
import { SidebarProvider, SidebarInset, SidebarTrigger } from './lib/shadcn/sidebar'
import AppSidebar from './components/AppSidebar'

const THEME_KEY = 'ufwt_theme'

function getInitialTheme(): 'light' | 'dark' {
  const stored = localStorage.getItem(THEME_KEY)
  if (stored === 'light' || stored === 'dark') return stored
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('quickscore')
  const [theme, setTheme] = useState<'light' | 'dark'>(getInitialTheme)
  const isDesktop = useMediaQuery('(min-width: 1024px)')
  const { user, allowed, loading, logout } = useAuth()

  useEffect(() => {
    const root = document.documentElement
    if (theme === 'dark') root.classList.add('dark')
    else root.classList.remove('dark')
    localStorage.setItem(THEME_KEY, theme)
  }, [theme])

  const toggleTheme = () => setTheme(t => t === 'dark' ? 'light' : 'dark')

  if (loading) {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    )
  }

  // Recovery-link landing page (the auth gateway redirects here after
  // verifying the email token and setting session cookies).
  if (window.location.pathname === '/reset-password') {
    return <ResetPassword />
  }

  // Anyone signed in may enter (read-only). The `allowed` flag now means
  // "team member — can write"; write controls are gated on it, and the DB's
  // RLS is the real enforcement (002_public_read_team_write.sql).
  if (!user) {
    return <Login />
  }

  const pageContent = (
    <>
      {activeTab === 'schedule' && <Schedule />}
      {activeTab === 'roster' && <Roster />}
      {activeTab === 'quickscore' && <QuickScore />}
      {activeTab === 'ranking' && <Ranking />}
      {activeTab === 'stats' && <Stats />}
      {activeTab === 'chat' && <Chat />}
    </>
  )

  const readOnlyNotice = !allowed && (
    <div className="bg-accent border-b border-border">
      <div className="max-w-2xl mx-auto px-4 py-2 text-xs text-muted-foreground text-center">
        You have read-only access. Ask a team admin to add you for editing.
      </div>
    </div>
  )

  // Desktop: collapsible sidebar shell.
  if (isDesktop) {
    const activeLabel = NAV_ITEMS.find(item => item.key === activeTab)?.label ?? ''
    return (
      <SidebarProvider>
        <AppSidebar
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          theme={theme}
          toggleTheme={toggleTheme}
          userEmail={user.email}
          logout={logout}
        />
        <SidebarInset>
          <header className="sticky top-0 z-10 flex h-14 items-center gap-2 border-b border-border bg-card px-4">
            <SidebarTrigger />
            <h1 className="text-lg font-bold text-primary">{activeLabel}</h1>
          </header>
          {readOnlyNotice}
          <main className="px-6 py-6">
            {pageContent}
          </main>
        </SidebarInset>
      </SidebarProvider>
    )
  }

  // Mobile: sticky header plus fixed bottom navigation.
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="bg-card border-b border-border sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between">
          <h1 className="text-lg font-bold text-primary">Warrior Tracker</h1>
          <div className="flex items-center gap-1">
            <button
              onClick={toggleTheme}
              className="p-2 rounded-lg hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
              aria-label="Toggle theme"
            >
              {theme === 'dark' ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            </button>
            <button
              onClick={() => logout()}
              className="p-2 rounded-lg hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
              aria-label="Sign out"
              title={user.email}
            >
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      {readOnlyNotice}

      <main className="max-w-2xl mx-auto px-4 py-6 pb-24">
        {pageContent}
      </main>

      <nav className="fixed bottom-0 left-0 right-0 bg-card border-t border-border">
        <div className="max-w-2xl mx-auto grid grid-cols-6">
          {NAV_ITEMS.map(({ key, icon: Icon, label }) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`flex flex-col items-center gap-1 py-3 transition-colors ${
                activeTab === key ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Icon className="w-5 h-5" />
              <span className="text-[10px] font-medium">{label}</span>
            </button>
          ))}
        </div>
      </nav>
    </div>
  )
}
```

Notes on what changed and why:
- Removed the local `type Tab`, the unused top-level `TABS` const, the unused `LIME`/`LIME_DIM` constants, and the inline `tabs` array. Navigation now comes from `NAV_ITEMS` (single source of truth). The icon imports `Zap, Calendar, Users, Award, BarChart3, MessageCircle` moved to `lib/nav.ts`, so `App.tsx` only imports `Moon, Sun, Loader2, LogOut`.
- `user.email` is used for the sidebar footer tooltip and the mobile logout title, matching prior behavior.
- The read-only notice and page content are each defined once and reused in both shells.

- [ ] **Step 2: Verify typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors referencing `App.tsx`. (Pre-existing `pages/*` errors may remain; they are unrelated.)

- [ ] **Step 3: Verify production build**

Run: `npm run build` (from repo root)
Expected: build completes successfully, `frontend/dist` regenerated. A chunk-size warning is pre-existing and acceptable.

- [ ] **Step 4: Manual browser check**

Run: `npm run dev` (from repo root), open `http://localhost:5000`, sign in.
Confirm:
- At a wide window (>= 1024px): the left sidebar shows with branding, the 6 nav items, and a footer with theme toggle and the signed-in email. Clicking items switches pages and highlights the active one. The trigger button (and Cmd/Ctrl+B) collapses the sidebar to an icon rail; hovering a collapsed item shows its tooltip. Theme toggle and logout work from the footer.
- Narrow the window below 1024px: the layout switches to the original mobile shell (top header with theme/logout, fixed bottom nav with 6 tabs). The active tab is preserved across the switch.
- If `allowed` is false, the read-only banner appears in both shells.

- [ ] **Step 5: Commit**

```bash
git add frontend/App.tsx frontend/dist
git commit -m "Switch App shell between desktop sidebar and mobile bottom nav"
```

---

## Self-Review

**Spec coverage:**
- Two shells, one nav config, one active-tab state: Tasks 4, 5, 6. Covered.
- Media-query selection at 1024px (not CSS hidden), sidebar always in desktop mode: Task 4 (`use-media-query.ts`), Task 6 (`isDesktop` branch). Covered.
- `collapsible="icon"`, branding header, nav content, footer with user/theme/logout: Task 5. Covered.
- Full-width desktop content via `SidebarInset`; pages keep inner constraints: Task 6 (`<main className="px-6 py-6">`, no `max-w`). Covered.
- shadcn primitives added manually to `lib/shadcn/` (sheet, tooltip, separator, sidebar, use-mobile): Tasks 2, 3. Covered.
- `--sidebar-*` tokens in `index.css` + `tailwind.config.js` sidebar color group; `orgTheme.css` left alone because it is not imported: Task 1. Covered.
- Mobile layout/bottom nav/page internals unchanged; no React Router; no new deps: Task 6 preserves the mobile shell; Global Constraints. Covered.
- Read-only `!allowed` banner in both shells: Task 6 (`readOnlyNotice`). Covered.

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N". All file contents are complete and inline.

**Type consistency:** `Tab` defined once in `lib/nav.ts` and imported by `App.tsx` and `AppSidebar.tsx`. `NAV_ITEMS` shape `{ key: Tab; label: string; icon: LucideIcon }` is consumed consistently (`icon: Icon` rename in both the sidebar map and the mobile nav map). `SidebarMenuButton` props used in Task 5 (`isActive`, `onClick`, `tooltip`, `size`, `className`) all exist in the Task 3 definition. `AppSidebar` prop names (`activeTab`, `setActiveTab`, `theme`, `toggleTheme`, `userEmail`, `logout`) match the Task 6 call site. `useMediaQuery(query: string): boolean` signature matches its single call.
