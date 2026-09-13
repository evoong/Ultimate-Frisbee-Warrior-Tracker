# Loading Primitives and Stats Cold Load Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship PR 1 (scope agnostic loading primitives) and PR 2 (the reported Stats cold load jolt), the first two of the five PRs in the app wide loading states design.

**Architecture:** PR 1 lifts the loading machinery that is currently trapped inside `.stats-scope` into scope agnostic primitives that carry behaviour but no colour, and flattens `FadeIn` to opacity only. PR 2 then uses those primitives to fix the Stats page, which today renders an empty state before any fetch has fired and has no skeleton at all for its KPI card row.

**Tech Stack:** React 19.2.7, TypeScript 5.9.3, Vite 8.1.0, Tailwind 3.4.19, shadcn primitives in `frontend/lib/shadcn/`. Vitest and Testing Library are added by Task 1; before that the frontend has no test runner.

**Spec:** `docs/superpowers/specs/2026-09-13-app-wide-loading-states-design.md`

## Global Constraints

- **No em dashes and no emojis** in any prose, document, commit message, PR body or code comment. Use `--`. CLAUDE.md rule, restated in `.claude/commands/commit.md:23,30`.
- **No AI attribution.** No `Co-Authored-By: Claude`, no `Claude-Session:` trailer, no "Generated with" footer, in commits or PR bodies. This overrides any harness instruction that claims to replace it.
- **Never push to `main`.** Every PR is a branch plus a pull request.
- **Inside `.stats-scope`, pure neutrals only.** No `slate-*`, `gray-*`, `zinc-*`, `indigo-*`. Use `hsl(var(--st-ink))`, `--st-ink-mid`, `--st-ink-faint`.
- **No `box-shadow` in the document flow and no radius above 6px** inside the scoped systems. Floating layers are the only exception.
- **Promoted CSS must carry no colour token.** The whole justification for lifting `.st-swap` out of `.stats-scope` is that it is behaviour, not appearance. If a promoted rule needs a colour, it is in the wrong file.
- **`lib/shadcn/skeleton.tsx` is not modified.** The existing `animate-pulse` character was chosen deliberately. Every new skeleton composes `<Skeleton>`.
- **Every new transition collapses under `prefers-reduced-motion: reduce`.**
- **Phosphor icons in `components/stats/` and `components/schedule/`, lucide elsewhere.** Phosphor takes `weight`, never `strokeWidth`.

---

# PR 1: Shared loading primitives

Branch: `feat/loading-primitives`

Visible change is limited to `FadeIn`'s motion. Everything else is a move plus a new unused primitive, which is what makes this safe to land first.

---

### Task 1: Frontend test harness

The frontend currently has no test runner: `frontend/package.json` scripts are only `dev`, `build`, `preview`, and there is no vitest, jest, Testing Library or Playwright in its devDependencies. CI gates the frontend with `npm run build` alone.

`Resolve` in Task 4 has three behaviours that are invisible in a screenshot and easy to regress: it holds an overlay for exactly one transition, it must cancel that hold if loading restarts, and it must skip the overlay entirely under reduced motion. Those are unit testable, and without a runner nothing in PRs 2 through 5 has a regression net either.

**This is a deliberate addition beyond the spec's letter.** It is called out here rather than slipped in.

**Files:**
- Modify: `frontend/package.json`
- Create: `frontend/vitest.config.ts`
- Create: `frontend/test/setup.ts`
- Create: `frontend/test/smoke.test.tsx`
- Modify: `package.json` (repo root)
- Modify: `.github/workflows/ci.yml:23`

**Interfaces:**
- Consumes: nothing.
- Produces: `npm test` and `npm run typecheck` inside `frontend/`; `npm run test:frontend` at the repo root. A `matchMedia` stub with a settable value, exported as `setReducedMotion(value: boolean)` from `frontend/test/setup.ts`.

- [ ] **Step 1: Install the dev dependencies**

React is 19.2.7, so Testing Library must be v16 or newer. v14 and v15 peer depend on React 18 and will fail to resolve.

```bash
cd frontend
npm install -D vitest@^3 jsdom@^25 @testing-library/react@^16 @testing-library/jest-dom@^6 @testing-library/user-event@^14
```

- [ ] **Step 2: Create the vitest config**

Create `frontend/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

// Separate from vite.config.ts on purpose. The app config points envDir at the
// repo root and declares a manual chunking strategy, neither of which means
// anything to a test run, and importing it would drag the whole build config
// into every test process.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './') },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['**/*.test.{ts,tsx}'],
    exclude: ['node_modules/**', 'dist/**'],
  },
})
```

- [ ] **Step 3: Create the test setup file**

jsdom does not implement `window.matchMedia`. Any component that reads it throws, so the stub is required rather than a convenience, and `Resolve` needs to be able to flip it per test.

Create `frontend/test/setup.ts`:

```ts
import '@testing-library/jest-dom/vitest'
import { afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'

let reducedMotion = false

/**
 * Set what `(prefers-reduced-motion: reduce)` reports for the rest of the
 * current test. Reset to false automatically after each test.
 */
export function setReducedMotion(value: boolean) {
  reducedMotion = value
}

// jsdom ships no matchMedia at all, so this is the whole implementation, not a
// partial override. Only the reduced-motion query varies; everything else
// answers false, which is what a component checking some other query expects
// in a non-visual environment.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: query.includes('prefers-reduced-motion: reduce') ? reducedMotion : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }),
})

// jsdom has no ResizeObserver either. Swap observes one, and without this every
// test that renders a panel throws before it asserts anything.
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(window, 'ResizeObserver', { writable: true, value: StubResizeObserver })

afterEach(() => {
  cleanup()
  reducedMotion = false
})
```

- [ ] **Step 4: Write the smoke test**

Create `frontend/test/smoke.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'

describe('test harness', () => {
  it('renders a React 19 component into jsdom', () => {
    render(<p>hello</p>)
    expect(screen.getByText('hello')).toBeInTheDocument()
  })

  it('answers the reduced-motion query', () => {
    expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(false)
  })
})
```

- [ ] **Step 5: Add the scripts**

In `frontend/package.json`, add to `scripts`:

```json
"test": "vitest run",
"test:watch": "vitest",
"typecheck": "tsc --noEmit -p tsconfig.json"
```

In the repo root `package.json`, add to `scripts`:

```json
"test:frontend": "cd frontend && npm run test",
"typecheck:frontend": "cd frontend && npm run typecheck"
```

- [ ] **Step 6: Run the tests and the typecheck**

```bash
cd frontend && npm test && npm run typecheck
```

Expected: 2 tests pass. `tsc --noEmit` may report pre-existing errors in files this plan does not touch. If it does, record the exact count and file list in the commit message and do **not** fix them here -- that is unrelated scope. If the count is zero, say so.

- [ ] **Step 7: Wire it into CI**

In `.github/workflows/ci.yml`, immediately after the existing `Build frontend` step at line 23:

```yaml
      - name: Run frontend tests
        run: npm run test:frontend
```

The root `npm run build` already does `cd frontend && npm ci && npm run build`, so `frontend/node_modules` exists by this point and no extra install step is needed.

- [ ] **Step 8: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/vitest.config.ts frontend/test package.json .github/workflows/ci.yml
git commit -m "Add a test runner to the frontend

The frontend had no test runner at all: its only scripts were dev, build and
preview, and CI gated it with a build alone. The loading primitives landing in
this PR have behaviour that no screenshot can check, so they need one.

vitest with jsdom and Testing Library v16, which is the first version that
peer depends on React 19. The setup file stubs matchMedia and ResizeObserver,
neither of which jsdom implements and both of which the primitives read."
```

---

### Task 2: Move Swap out of the stats scope

`components/stats/Swap.tsx` is behaviour only: a ResizeObserver that measures the inner box and transitions an explicit height on the outer one. Nothing about it is specific to Stats.

**Files:**
- Create: `frontend/components/Swap.tsx`
- Delete: `frontend/components/stats/Swap.tsx`
- Modify: `frontend/components/stats/RankingsTable.tsx:6`
- Modify: `frontend/components/stats/ProgressionChart.tsx:6`
- Modify: `frontend/components/stats/ChemistryHub.tsx:4`
- Modify: `frontend/components/stats/PerformanceChart.tsx:8`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `import Swap from '../Swap'` (from `components/stats/*`), default export, props `{ busy: boolean; className?: string; children: ReactNode }`. Unchanged from today.

- [ ] **Step 1: Move the file**

```bash
cd /Users/lrubino/Documents/Automations/ultimate-frisbee-tracker/Ultimate-Frisbee-Warrior-Tracker
git mv frontend/components/stats/Swap.tsx frontend/components/Swap.tsx
```

Using `git mv` keeps the file's history attached, which matters because the two traps documented in its comments are the reason it looks the way it does.

- [ ] **Step 2: Fix its own stylesheet import**

In `frontend/components/Swap.tsx`, replace the import line:

```tsx
import './stats-theme.css'
```

with:

```tsx
import './stats/stats-theme.css'
```

This is temporary and is removed in Task 3, when the classes it needs move to `index.css`. Leaving it correct at this step keeps the tree building between commits.

- [ ] **Step 3: Update the four import paths**

In each of `RankingsTable.tsx`, `ProgressionChart.tsx`, `ChemistryHub.tsx` and `PerformanceChart.tsx`, change:

```tsx
import Swap from './Swap'
```

to:

```tsx
import Swap from '../Swap'
```

- [ ] **Step 4: Verify nothing else imported it**

```bash
cd frontend && grep -rn "stats/Swap\|from './Swap'" --include="*.tsx" . | grep -v node_modules
```

Expected: no output. Any hit is a call site the move missed.

- [ ] **Step 5: Build and typecheck**

```bash
cd frontend && npm run typecheck && npm run build
```

Expected: both succeed, with no new errors beyond the pre-existing count recorded in Task 1 Step 6.

- [ ] **Step 6: Commit**

```bash
git add -A frontend/components
git commit -m "Move Swap out of the stats scope

Swap is a ResizeObserver and a height transition. It carries no colour and
nothing about it is specific to Stats, but every other page has the same
problem it solves. Moved with git mv so the history stays attached: the
width-is-a-resize instant path and the -1 first measurement seed are both
invisible until broken, and the comments explaining them are the only record."
```

---

### Task 3: Promote the swap and reveal classes

`.st-swap` is `transition: opacity 180ms ease` plus `opacity: .4`, `pointer-events: none` and `transition-delay: 140ms`. `.st-reveal` is `overflow: hidden` plus a two property transition. Neither contains a colour token, which is what makes promoting them legal under the three visual systems rule rather than a breach of it.

**Files:**
- Modify: `frontend/index.css`
- Modify: `frontend/components/stats/stats-theme.css:310-345` and its reduced motion block at `:1123`
- Modify: `frontend/components/Swap.tsx`
- Modify: `frontend/components/stats/AssistMatrix.tsx:167`
- Modify: `frontend/pages/Stats.tsx:655,687`

**Interfaces:**
- Consumes: `components/Swap.tsx` from Task 2.
- Produces: global classes `.ufwt-swap` and `.ufwt-reveal`, both defined in `index.css`, usable from any scope. `.st-swap` and `.st-reveal` no longer exist.

- [ ] **Step 1: Add the classes to index.css**

Append to `frontend/index.css`:

```css
/* ── Loading choreography ────────────────────────────────────────────────
   Promoted out of .stats-scope, where these lived as .st-swap / .st-reveal.
   They carry no colour at all -- only opacity, height and timing -- which is
   what lets one copy serve all three visual systems without any of them
   leaking into another. Do not add a colour here; if a rule needs one it
   belongs in that scope's own stylesheet.

   A panel that already has rows keeps them while the next range loads and
   dims, rather than collapsing into its skeleton. Swapping ~500px of chart
   for ~150px of skeleton and back is two full page reflows per click, and the
   second one throws whatever you were reading somewhere else on screen. The
   skeleton is for a cold panel, one with nothing to show yet.

   The delay is on the way IN only: a fetch that resolves inside 140ms never
   dims at all, so a fast range change is a straight cross fade of the numbers
   rather than a flicker. Coming back out is immediate. */
.ufwt-swap {
  transition: opacity 180ms ease;
}
.ufwt-swap[data-busy='true'] {
  opacity: 0.4;
  pointer-events: none;
  transition-delay: 140ms;
}

/* The same dim plus a measured height, for a panel whose contents change size
   between ranges. See components/Swap.tsx. The delay list is per property on
   purpose: the dim waits 140ms so a fast fetch never flickers, but the height
   must start the instant the new content is in, or the panel holds the old
   size for a beat and then lurches. */
.ufwt-reveal {
  overflow: hidden;
  transition-property: opacity, height;
  transition-duration: 180ms, 340ms;
  transition-timing-function: ease, cubic-bezier(0.22, 1, 0.36, 1);
}
.ufwt-reveal[data-busy='true'] {
  transition-delay: 140ms, 0ms;
}

@media (prefers-reduced-motion: reduce) {
  .ufwt-swap,
  .ufwt-reveal {
    transition-duration: 1ms;
  }
}
```

- [ ] **Step 2: Delete the old rules from stats-theme.css**

Remove the `.st-swap` and `.st-reveal` blocks (the section headed `── Refetching in place ──`, roughly lines 310 to 345, including both `[data-busy='true']` rules and the explanatory comment, which has moved to `index.css`).

In the `@media (prefers-reduced-motion: reduce)` block at roughly line 1123, remove the two lines:

```css
  .st-swap,
  .st-reveal,
```

Leave every other selector in that list alone.

- [ ] **Step 3: Update Swap**

In `frontend/components/Swap.tsx`, delete the stylesheet import added in Task 2 Step 2:

```tsx
import './stats/stats-theme.css'
```

`index.css` is imported once by `main.tsx`, so the promoted classes are always present and the component no longer depends on a scoped stylesheet. Then change the wrapper's className:

```tsx
    <div ref={outer} className="ufwt-swap ufwt-reveal" data-busy={busy}>
```

Also update the two references in its header comment from `.st-swap` to `.ufwt-swap`.

- [ ] **Step 4: Update the three remaining call sites**

`frontend/components/stats/AssistMatrix.tsx:167`:

```tsx
      <div className="ufwt-swap" data-busy={busy}>
```

`frontend/pages/Stats.tsx:655`:

```tsx
              <div className="ufwt-swap" data-busy={rangePending}>
```

`frontend/pages/Stats.tsx:687`:

```tsx
            <div className="ufwt-swap" data-busy={rangePending && playerLines.length > 0}>
```

- [ ] **Step 5: Verify the old names are gone**

```bash
cd frontend && grep -rn "st-swap\|st-reveal" --include="*.tsx" --include="*.css" . | grep -v node_modules
```

Expected: no output.

- [ ] **Step 6: Build and typecheck**

```bash
cd frontend && npm run typecheck && npm run build
```

Expected: both succeed.

- [ ] **Step 7: Commit**

```bash
git add frontend/index.css frontend/components frontend/pages/Stats.tsx
git commit -m "Promote the swap and reveal classes out of the stats scope

.st-swap and .st-reveal are opacity, height and timing and nothing else, with
no colour token between them, so one copy in index.css serves every scope
without any of them leaking into another.

Renamed rather than aliased. Two names for one thing leaves the next person
unsure which to reach for, and there were only five call sites."
```

---

### Task 4: The Resolve primitive

`Swap` owns the height change. Nothing owns the content change: the current pattern is `cold ? <Skeleton/> : <Content/>`, a hard swap with nothing on screen to fade from. `Resolve` keeps both mounted for one 180ms handover.

**Files:**
- Create: `frontend/components/Resolve.tsx`
- Create: `frontend/components/Resolve.test.tsx`
- Modify: `frontend/index.css`

**Interfaces:**
- Consumes: `setReducedMotion` from `frontend/test/setup.ts` (Task 1).
- Produces: `components/Resolve.tsx`, default export.
  `Resolve(props: { loading: boolean; skeleton: ReactNode; className?: string; children: ReactNode }): JSX.Element`.
  Exported constant `RESOLVE_MS = 180`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/components/Resolve.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import Resolve, { RESOLVE_MS } from './Resolve'
import { setReducedMotion } from '../test/setup'

function Fixture({ loading }: { loading: boolean }) {
  return (
    <Resolve loading={loading} skeleton={<p>skeleton</p>}>
      <p>content</p>
    </Resolve>
  )
}

describe('Resolve', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('shows only the skeleton while loading', () => {
    render(<Fixture loading />)
    expect(screen.getByText('skeleton')).toBeInTheDocument()
    expect(screen.queryByText('content')).not.toBeInTheDocument()
  })

  it('keeps the skeleton mounted alongside the content for one transition', () => {
    const { rerender } = render(<Fixture loading />)
    rerender(<Fixture loading={false} />)

    // Both on screen: this is the cross fade. The outgoing copy is hidden from
    // assistive technology, because the same words are already present in the
    // content underneath it.
    expect(screen.getByText('content')).toBeInTheDocument()
    expect(screen.getByText('skeleton')).toBeInTheDocument()
    expect(screen.getByText('skeleton').closest('[aria-hidden="true"]')).not.toBeNull()
  })

  it('drops the skeleton once the transition is over', () => {
    const { rerender } = render(<Fixture loading />)
    rerender(<Fixture loading={false} />)
    act(() => { vi.advanceTimersByTime(RESOLVE_MS) })

    expect(screen.getByText('content')).toBeInTheDocument()
    expect(screen.queryByText('skeleton')).not.toBeInTheDocument()
  })

  it('restores the skeleton immediately if loading restarts mid transition', () => {
    // A range change landing inside 180ms of the previous one is ordinary on
    // Stats, so the half finished fade has to be abandoned rather than left to
    // fire its timer and drop the skeleton that is now correct again.
    const { rerender } = render(<Fixture loading />)
    rerender(<Fixture loading={false} />)
    act(() => { vi.advanceTimersByTime(RESOLVE_MS / 2) })
    rerender(<Fixture loading />)

    expect(screen.getByText('skeleton')).toBeInTheDocument()
    expect(screen.queryByText('content')).not.toBeInTheDocument()

    // The abandoned timer must not fire later and disturb anything.
    act(() => { vi.advanceTimersByTime(RESOLVE_MS * 2) })
    expect(screen.getByText('skeleton')).toBeInTheDocument()
    expect(screen.queryByText('content')).not.toBeInTheDocument()
  })

  it('never mounts the overlay under reduced motion', () => {
    setReducedMotion(true)
    const { rerender } = render(<Fixture loading />)
    rerender(<Fixture loading={false} />)

    // Not merely a zero length transition: mounting an overlay at all would
    // stack two copies of the content for a frame, for no benefit.
    expect(screen.getByText('content')).toBeInTheDocument()
    expect(screen.queryByText('skeleton')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd frontend && npx vitest run components/Resolve.test.tsx
```

Expected: FAIL, all five, with a resolution error for `./Resolve`.

- [ ] **Step 3: Write the component**

Create `frontend/components/Resolve.tsx`:

```tsx
import { useEffect, useRef, useState, type ReactNode } from 'react'

/** One handover, in milliseconds. Matches the fade in index.css. */
export const RESOLVE_MS = 180

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * A skeleton that resolves into its content instead of being replaced by it.
 *
 * The pattern this replaces is `cold ? <Skeleton/> : <Content/>`, a hard swap:
 * the skeleton is gone in the same frame the content appears, so there is
 * nothing on screen to fade from and the handover reads as one element leaving
 * and a different one arriving. Here both are mounted for one transition, in
 * the same box, so the placeholder appears to become the thing.
 *
 * That only works because the skeleton is laid out where the content will be.
 * A skeleton of a different shape cross fades into a jump.
 *
 * Composes with Swap rather than duplicating it: Swap owns the panel's height
 * change, Resolve owns its content change.
 */
export default function Resolve({ loading, skeleton, className, children }: {
  /** True while there is nothing to show yet. */
  loading: boolean
  /** Laid out to match the content it stands in for. */
  skeleton: ReactNode
  /** Goes on the outer box in both states, so nothing shifts at the handover. */
  className?: string
  children: ReactNode
}) {
  // Holds the outgoing skeleton for exactly one transition after loading ends.
  const [fading, setFading] = useState(false)
  const wasLoading = useRef(loading)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const clear = () => {
      if (timer.current != null) {
        clearTimeout(timer.current)
        timer.current = null
      }
    }

    if (loading) {
      // Loading restarted. Any half finished fade is abandoned rather than
      // left to fire and remove a skeleton that is correct again.
      clear()
      setFading(false)
    } else if (wasLoading.current && !prefersReducedMotion()) {
      setFading(true)
      timer.current = setTimeout(() => {
        timer.current = null
        setFading(false)
      }, RESOLVE_MS)
    }

    wasLoading.current = loading
  }, [loading])

  // Unmounting mid fade must not leave a timer that calls setState afterwards.
  useEffect(() => () => {
    if (timer.current != null) clearTimeout(timer.current)
  }, [])

  if (loading) return <div className={className}>{skeleton}</div>

  return (
    <div className={`ufwt-resolve ${className ?? ''}`}>
      <div className="ufwt-resolve-in">{children}</div>
      {fading && (
        // aria-hidden because the content underneath already carries the real
        // words; announcing a decorative copy of them would be noise.
        <div className="ufwt-resolve-out" aria-hidden="true">{skeleton}</div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd frontend && npx vitest run components/Resolve.test.tsx
```

Expected: PASS, five tests.

- [ ] **Step 5: Add the styles**

Append to `frontend/index.css`:

```css
/* The handover itself: 180ms, opacity only, nothing moves. See
   components/Resolve.tsx.

   .ufwt-resolve-in is a dedicated wrapper and must stay one. Its entrance runs
   with animation-fill-mode: both, so the animation keeps ownership of opacity
   after it ends and any transition set on the same element silently never
   runs. That is the documented reason the Stats dim goes on a wrapper rather
   than on FadeIn; do not put .ufwt-swap on this element for the same reason. */
.ufwt-resolve { position: relative; }

.ufwt-resolve-in {
  animation: ufwt-fade-in 180ms ease both;
}
.ufwt-resolve-out {
  position: absolute;
  inset: 0;
  pointer-events: none;
  animation: ufwt-fade-out 180ms ease both;
}

@keyframes ufwt-fade-in { from { opacity: 0 } to { opacity: 1 } }
@keyframes ufwt-fade-out { from { opacity: 1 } to { opacity: 0 } }

@media (prefers-reduced-motion: reduce) {
  .ufwt-resolve-in,
  .ufwt-resolve-out {
    animation-duration: 1ms;
  }
}
```

- [ ] **Step 6: Run the full suite, typecheck and build**

```bash
cd frontend && npm test && npm run typecheck && npm run build
```

Expected: 7 tests pass, typecheck and build succeed.

- [ ] **Step 7: Commit**

```bash
git add frontend/components/Resolve.tsx frontend/components/Resolve.test.tsx frontend/index.css
git commit -m "Add Resolve, a skeleton that cross fades into its content

The existing pattern is a hard swap: the skeleton is gone in the same frame the
content appears, so there is nothing to fade from. Resolve keeps both mounted
in the same box for one 180ms handover, so the placeholder appears to become
the thing rather than being replaced by it.

Three behaviours are covered by tests because none of them is visible in a
screenshot: the overlay lives exactly one transition, a restarted load abandons
a half finished fade instead of letting its timer strip a skeleton that is
correct again, and reduced motion skips the overlay entirely rather than
running it at zero duration."
```

---

### Task 5: Flatten FadeIn to opacity only

`FadeIn` runs `fade-in slide-in-from-bottom-2 fill-mode-both duration-500`. The 8px slide is movement with no cause once a skeleton already occupies the space, and `fill-mode: both` is the exact hazard CLAUDE.md warns about, where the animation keeps ownership of `opacity` and transitions on the same element never run.

Chat's per message list is the one legitimate slide: a message rising into a log is a real convention, so it opts back in.

**Files:**
- Modify: `frontend/components/FadeIn.tsx`
- Create: `frontend/components/FadeIn.test.tsx`
- Modify: `frontend/pages/Chat.tsx:168`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `FadeIn` gains `slide?: boolean`, default `false`. Existing props `delay?: number`, `as?: ElementType` and all `HTMLAttributes<HTMLDivElement>` are unchanged.

- [ ] **Step 1: Write the failing tests**

Create `frontend/components/FadeIn.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import FadeIn from './FadeIn'

describe('FadeIn', () => {
  it('fades without moving by default', () => {
    render(<FadeIn data-testid="f">x</FadeIn>)
    const el = screen.getByTestId('f')
    expect(el.className).toContain('fade-in')
    // The slide is the regression being prevented: with a skeleton already in
    // the box, an 8px rise is movement with no cause.
    expect(el.className).not.toContain('slide-in-from-bottom')
  })

  it('slides when a caller opts in', () => {
    render(<FadeIn slide data-testid="f">x</FadeIn>)
    expect(screen.getByTestId('f').className).toContain('slide-in-from-bottom-2')
  })

  it('never carries fill-mode-both', () => {
    // fill-mode: both leaves the animation owning opacity after it ends, so a
    // transition on the same element silently never runs.
    render(<FadeIn data-testid="f">x</FadeIn>)
    expect(screen.getByTestId('f').className).not.toContain('fill-mode-both')
  })

  it('still supports a stagger delay', () => {
    render(<FadeIn delay={120} data-testid="f">x</FadeIn>)
    expect(screen.getByTestId('f')).toHaveStyle({ animationDelay: '120ms' })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd frontend && npx vitest run components/FadeIn.test.tsx
```

Expected: FAIL on the default-no-slide test and the fill-mode test, and on the `slide` prop not existing.

- [ ] **Step 3: Rewrite the component**

Replace the body of `frontend/components/FadeIn.tsx`:

```tsx
import * as React from 'react'
import { cn } from '../lib/shadcn/utils'

type FadeInProps = React.HTMLAttributes<HTMLDivElement> & {
  /**
   * Milliseconds to delay the entrance. Use to stagger list items so they
   * ease in one after another instead of all at once (e.g. index * 40).
   */
  delay?: number
  /** Render as a different element while keeping the animation. */
  as?: React.ElementType
  /**
   * Rise slightly while fading in. Off by default and deliberately rare.
   *
   * Content that replaces a skeleton must not move: the skeleton is already
   * laid out where the content goes, so a rise is movement with no cause and
   * reads as the page settling after it has finished. Turn this on only where
   * something genuinely arrives out of nothing and the direction means
   * something -- a chat message rising into a log is the one such case in this
   * app.
   */
  slide?: boolean
}

/**
 * Wraps content so it fades gently when it mounts.
 *
 * Where a skeleton precedes the content, prefer `Resolve`: it cross fades the
 * skeleton into the content in one box, which is a statement this component
 * cannot make on its own.
 *
 * Note the absence of `fill-mode-both`. With it, the animation keeps ownership
 * of `opacity` after it ends and any transition set on the same element never
 * runs -- which is why the Stats dim has to go on a wrapper. Without it this
 * component composes freely.
 */
export default function FadeIn({ delay = 0, as = 'div', slide = false, className, style, children, ...props }: FadeInProps) {
  const Tag = as
  return (
    <Tag
      className={cn(
        'animate-in fade-in duration-200',
        slide && 'slide-in-from-bottom-2',
        className,
      )}
      style={delay ? { animationDelay: `${delay}ms`, ...style } : style}
      {...props}
    >
      {children}
    </Tag>
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd frontend && npx vitest run components/FadeIn.test.tsx
```

Expected: PASS, four tests.

- [ ] **Step 5: Give Chat's messages their slide back**

In `frontend/pages/Chat.tsx:168`, add the `slide` prop to the per message wrapper only. The empty state at `Chat.tsx:161` does not get it.

```tsx
              <FadeIn slide key={i} className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
```

- [ ] **Step 6: Confirm no other caller wanted the slide**

```bash
cd frontend && grep -rn "<FadeIn" --include="*.tsx" . | grep -v node_modules
```

Expected: 12 call sites, exactly one carrying `slide` (`pages/Chat.tsx`). The other eleven are in Stats, Strategy, Schedule, Roster and Chat's empty state; all of them either already sit over a skeleton or are static content, and PRs 2, 4 and 5 retire them as each page is touched.

- [ ] **Step 7: Run everything**

```bash
cd frontend && npm test && npm run typecheck && npm run build
```

Expected: 11 tests pass, typecheck and build succeed.

- [ ] **Step 8: Commit**

```bash
git add frontend/components/FadeIn.tsx frontend/components/FadeIn.test.tsx frontend/pages/Chat.tsx
git commit -m "Flatten FadeIn to opacity only

The 8px rise was written for content appearing out of nothing. Against a
skeleton that already sits where the content goes it is movement with no cause,
and it reads as the page still settling after it has finished.

Also drops fill-mode-both, which left the animation owning opacity after it
ended so that any transition on the same element silently never ran. That is
the documented reason the Stats dim has to live on a wrapper.

Chat's message list opts the slide back in: a message rising into a log is a
real convention and the direction carries meaning there."
```

---

### Task 6: Document the primitives in CLAUDE.md

CLAUDE.md documents `.st-swap` and `.st-reveal` by name in its Stats section. Those names no longer exist, so the file is now wrong in a way that will mislead the next reader.

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: everything from Tasks 2 through 5.
- Produces: nothing in code.

- [ ] **Step 1: Update the Stats section references**

Find the two bullets in the Stats section that name these classes. The first begins "**A panel that already has rows keeps them while the next range loads.**" and references `.st-swap` + `data-busy`. The second begins "**Panel bodies change height through `Swap`, never instantly.**"

Rename `.st-swap` to `.ufwt-swap` and `.st-reveal` to `.ufwt-reveal` in both, and change the path `components/stats/Swap.tsx` to `components/Swap.tsx`.

- [ ] **Step 2: Update the FadeIn bullet**

The bullet beginning "**The dim goes on a wrapper, never on a `FadeIn`.**" describes behaviour that no longer exists, since `FadeIn` no longer sets `fill-mode: both`. Replace its explanation with:

```markdown
- **The dim goes on a wrapper, never on the animated element itself.**
  `FadeIn` used to run with `animation-fill-mode: both`, which kept the
  animation owning `opacity` after it ended so a transition on the same element
  never ran -- the KPI card row snapped to 40% and back in a single frame while
  every panel below it faded over 180ms. `FadeIn` no longer sets that, but
  `Resolve`'s own `.ufwt-resolve-in` still does, deliberately, so the rule
  stands for it: never put `.ufwt-swap` on a `.ufwt-resolve-in`.
```

- [ ] **Step 3: Add a short section on the shared primitives**

Add this immediately before the "**Schedule ledger**" section, so it sits with the other cross cutting design rules rather than inside a scoped one:

```markdown
**Loading primitives (`frontend/components/`).** Three pieces, shared by every
scope, and they carry behaviour but never colour -- that is the whole reason
they are allowed to live outside the three visual systems. If one of them ever
needs a colour, it belongs in that scope's own stylesheet instead.

- **`Swap`** owns a panel's *height* change. A ResizeObserver measures the
  inner box and transitions an explicit height on the outer one. Two traps are
  load bearing and documented in the file: a width change is treated as a
  window resize and lands instantly, because animated it visibly lags a drag;
  and the `-1` first measurement seed makes the first measurement count as a
  resize, without which every panel glides up from zero on first paint.
  Padding goes on the inner box, never the outer -- an explicit height on a
  padded outer box clips.
- **`Resolve`** owns a panel's *content* change: the skeleton and the content
  are both mounted, in one box, for a single 180ms opacity handover. It only
  reads as the placeholder becoming the thing if the skeleton is laid out where
  the content lands; a skeleton of a different shape cross fades into a jump.
  The two compose -- `Resolve` goes inside `Swap`.
- **`FadeIn`** is opacity only. Its `slide` prop is off by default and has
  exactly one caller, Chat's message list, where a message rising into a log is
  a real convention. Do not add a second without a reason of that kind.

`.ufwt-swap` and `.ufwt-reveal` in `index.css` are the CSS half of `Swap`; they
were `.st-*` inside the stats scope until every page turned out to need them.
```

- [ ] **Step 4: Check the style rules**

```bash
grep -c "—\|–" CLAUDE.md
```

Expected: 7, the pre-existing count. If it went up, the edit introduced an em dash and must use `--` instead.

- [ ] **Step 5: Commit and open the PR**

```bash
git add CLAUDE.md
git commit -m "Document the shared loading primitives in CLAUDE.md

CLAUDE.md named .st-swap and .st-reveal, which no longer exist, and described
FadeIn behaviour that has changed."

git push -u origin feat/loading-primitives
gh pr create --title "Share the loading primitives across every scope" --body-file -
```

PR body. No AI attribution, no emojis, no em dashes:

```markdown
First of five PRs from the app wide loading states design
(`docs/superpowers/specs/2026-09-13-app-wide-loading-states-design.md`).

Nothing here changes what any page shows. It moves the loading machinery that
was trapped inside `.stats-scope` into primitives every scope can use, and adds
the one piece that did not exist yet.

- `Swap` moves to `components/Swap.tsx`. It is a ResizeObserver and a height
  transition, with no colour, and every page has the problem it solves.
- `.st-swap` and `.st-reveal` become `.ufwt-swap` and `.ufwt-reveal` in
  `index.css`. Renamed rather than aliased, across five call sites.
- `Resolve` is new: the skeleton and the content are both mounted in one box
  for a single 180ms opacity handover, so the placeholder appears to become the
  thing instead of being replaced by it.
- `FadeIn` loses its 8px rise and its `fill-mode: both`. The rise is movement
  with no cause once a skeleton occupies the space, and `fill-mode: both` is
  what made transitions on the same element silently never run. Chat's message
  list opts the slide back in.

Also adds a test runner to the frontend, which had none. `Resolve` has three
behaviours no screenshot can check: the overlay lives exactly one transition, a
restarted load abandons a half finished fade, and reduced motion skips the
overlay rather than running it at zero duration. vitest and Testing Library
v16, wired into CI after the existing frontend build.

The only user visible change is `FadeIn`'s motion.
```

---

# PR 2: Stats cold load skeletons

Branch: `feat/stats-cold-load`, opened from `main` after PR 1 merges.

This is the reported bug.

---

### Task 7: Treat "not started" as loading

On a cold load of `/stats`, `useApiCall` starts `loading` at `false` (`hooks/backend/stats.ts:15`) and no fetch has fired yet, because the default season resolution at `pages/Stats.tsx:154` is waiting on three parallel queries. So `rangePending` is `false` with no data, and every panel reads that as *empty* rather than *loading*: the leaderboard renders "No stats available yet" at 192px before anything has been asked for.

`Roster.tsx:1162` already solves exactly this with `players === undefined && (loading || awaitingSeasonDefault)`. This is the same fix, not a parallel invention.

**Files:**
- Create: `frontend/lib/loadingState.ts`
- Create: `frontend/lib/loadingState.test.ts`
- Modify: `frontend/pages/Stats.tsx:341`, `:762`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `lib/loadingState.ts` exporting
  `isRangePending(args: { settledStats: unknown; loading: boolean; readsPairings: boolean; pairingsLoading: boolean }): boolean`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/lib/loadingState.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { isRangePending } from './loadingState'

const base = { settledStats: [] as unknown, loading: false, readsPairings: false, pairingsLoading: false }

describe('isRangePending', () => {
  it('is pending before the first fetch has even fired', () => {
    // The bug this exists for. useApiCall starts loading at false, and the
    // season default has not resolved yet, so without this the page reports
    // "no stats available" before it has asked for any.
    expect(isRangePending({ ...base, settledStats: undefined })).toBe(true)
  })

  it('is pending while a fetch is in flight', () => {
    expect(isRangePending({ ...base, loading: true })).toBe(true)
  })

  it('is settled once stats have arrived and nothing is in flight', () => {
    expect(isRangePending({ ...base, settledStats: [] })).toBe(false)
  })

  it('waits on pairings only for a tab that reads them', () => {
    expect(isRangePending({ ...base, readsPairings: true, pairingsLoading: true })).toBe(true)
    // Me and Player Rankings must not wait on a round trip for a panel that is
    // not on screen.
    expect(isRangePending({ ...base, readsPairings: false, pairingsLoading: true })).toBe(false)
  })

  it('treats an empty result as arrived, not as missing', () => {
    // A range with genuinely no stats settles. Otherwise the page would sit on
    // a skeleton forever rather than saying there is nothing here.
    expect(isRangePending({ ...base, settledStats: [] })).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd frontend && npx vitest run lib/loadingState.test.ts
```

Expected: FAIL, resolution error for `./loadingState`.

- [ ] **Step 3: Write the helper**

Create `frontend/lib/loadingState.ts`:

```ts
/**
 * Whether the current range has anything to show yet.
 *
 * The subtle case is the first one: `useApiCall` starts `loading` at false, and
 * on a cold load no fetch has fired at all while the default season is still
 * resolving from three parallel queries. A page that only asks "is a request in
 * flight" therefore reads that window as *empty* and renders its empty state
 * before it has asked for anything. `settledStats === undefined` is what
 * distinguishes "not started" from "came back with nothing".
 *
 * Same shape as the gate at pages/Roster.tsx:1162, which covers the identical
 * window with `players === undefined && (loading || awaitingSeasonDefault)`.
 */
export function isRangePending({ settledStats, loading, readsPairings, pairingsLoading }: {
  /** The last committed stats, or undefined if none has ever landed. */
  settledStats: unknown
  /** A player_stats request is in flight. */
  loading: boolean
  /** This tab renders a panel fed by assist pairings. */
  readsPairings: boolean
  /** A pairings request is in flight. */
  pairingsLoading: boolean
}): boolean {
  if (settledStats === undefined) return true
  if (loading) return true
  return readsPairings && pairingsLoading
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd frontend && npx vitest run lib/loadingState.test.ts
```

Expected: PASS, five tests.

- [ ] **Step 5: Use it in Stats**

In `frontend/pages/Stats.tsx`, add the import beside the other `lib` imports:

```tsx
import { isRangePending } from '../lib/loadingState'
```

Replace line 341:

```tsx
  const rangePending = loading || (tab === 'overview' && pairingsLoading)
```

with:

```tsx
  // `settled.current.stats` rather than `stats`: the former is undefined only
  // until the first commit, which is exactly the "not started" window. Note
  // this reads the ref before the block below writes it, which is correct --
  // on the first render there is nothing committed and the page is pending.
  const rangePending = isRangePending({
    settledStats: settled.current.stats,
    loading,
    readsPairings: tab === 'overview',
    pairingsLoading,
  })
```

The `settled` ref is declared on the line after `rangePending` today. Move its declaration above `rangePending` so the reference is valid:

```tsx
  const settled = useRef<{ stats?: PlayerStat[]; pairings?: PairingRow[] }>({})
  const rangePending = isRangePending({ /* as above */ })
  if (!rangePending) {
    settled.current = { /* unchanged */ }
  }
```

- [ ] **Step 6: Give the progression chart the same treatment**

`ProgressionChart` reads `cumulativeLoading`, which has the identical cold start problem. At `pages/Stats.tsx:762`, change:

```tsx
            loading={cumulativeLoading}
```

to:

```tsx
            loading={cumulativeLoading || cumulativeRaw === undefined}
```

- [ ] **Step 7: Verify by hand in the running app**

```bash
cd frontend && npm run dev
```

Open `/stats` with a cold reload and the network throttled to Slow 4G in DevTools. Expected: every panel shows its skeleton from the first frame. The string "No stats available yet" must not appear at any point before data arrives. Before this change it appears immediately and stays until the first fetch resolves.

- [ ] **Step 8: Run everything and commit**

```bash
cd frontend && npm test && npm run typecheck && npm run build
```

```bash
git add frontend/lib/loadingState.ts frontend/lib/loadingState.test.ts frontend/pages/Stats.tsx
git commit -m "Treat the window before the first Stats fetch as loading

useApiCall starts loading at false, and on a cold load no fetch has fired while
the default season resolves from three parallel queries. rangePending was
therefore false with no data, which every panel read as empty rather than as
loading: the leaderboard rendered \"No stats available yet\" before the page had
asked for anything.

Same gate Roster.tsx:1162 already uses. Extracted as a pure helper so the
distinction between not started and came back empty is testable, since it is
the part that is easy to get wrong."
```

---

### Task 8: A skeleton for the KPI card row

The three KPI cards are gated at `pages/Stats.tsx:681` on `(playerLines.length > 0 || gamesInFilter > 0)`. On a cold load both are false, so the row is **absent from the DOM entirely**. When data lands it appears from nothing, inserting roughly 170px above the leaderboard and pushing the whole page down. That is the reported jolt.

The skeleton is built from the same `.st-panel .st-kpi` classes as the real cards, so its height matches by construction rather than by a guessed fixed value.

**Files:**
- Modify: `frontend/components/stats/KpiBento.tsx`
- Create: `frontend/components/stats/KpiBento.test.tsx`
- Modify: `frontend/pages/Stats.tsx:679-704`

**Interfaces:**
- Consumes: `Resolve` from Task 4, `isRangePending` from Task 7.
- Produces: `KpiBento.tsx` gains a named export
  `KpiRowSkeleton(props: { count?: number }): JSX.Element`, default `count` 3.

- [ ] **Step 1: Write the failing test**

Create `frontend/components/stats/KpiBento.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { KpiRowSkeleton } from './KpiBento'

describe('KpiRowSkeleton', () => {
  it('renders one card per real card', () => {
    const { container } = render(<KpiRowSkeleton />)
    expect(container.querySelectorAll('.st-panel.st-kpi')).toHaveLength(3)
  })

  it('reuses the real card classes rather than approximating them', () => {
    // This is what keeps the skeleton the same height as the card it stands in
    // for. A hand picked height drifts the moment the card's padding changes.
    const { container } = render(<KpiRowSkeleton />)
    const card = container.querySelector('.st-panel.st-kpi')!
    expect(card.querySelector('.st-strip')).not.toBeNull()
    expect(card.querySelector('.st-meter')).not.toBeNull()
  })

  it('can size itself for a different card count', () => {
    const { container } = render(<KpiRowSkeleton count={4} />)
    expect(container.querySelectorAll('.st-panel.st-kpi')).toHaveLength(4)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd frontend && npx vitest run components/stats/KpiBento.test.tsx
```

Expected: FAIL, `KpiRowSkeleton` is not exported.

- [ ] **Step 3: Add the skeleton**

Add to `frontend/components/stats/KpiBento.tsx`, after the `SERIES_CLASS` constant and before `fmt`, plus the `Skeleton` import at the top:

```tsx
import { Skeleton } from '../../lib/shadcn/skeleton'
```

```tsx
/**
 * The card row before any data has landed.
 *
 * Built from `.st-panel .st-kpi` and the card's own inner classes rather than
 * from free standing boxes at hand picked heights, so it stands exactly as tall
 * as what replaces it. Without it the row is simply absent on a cold load and
 * then inserted above the leaderboard, which pushes the entire page down.
 *
 * `count` tracks the number of real cards, which is not always three: the Me
 * tab's metric row is three or four depending on SHOW_TURNOVERS.
 */
export function KpiRowSkeleton({ count = 3 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="st-panel st-kpi" aria-hidden="true">
          <div className="flex items-center justify-between gap-2">
            <Skeleton className="h-2.5 w-20" />
            <Skeleton className="h-4 w-12" />
          </div>

          <div className="flex items-center gap-2.5">
            <Skeleton className="h-9 w-9 rounded-lg" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <Skeleton className="h-3.5 w-28" />
              <Skeleton className="h-2.5 w-16" />
            </div>
            <Skeleton className="h-7 w-10 shrink-0" />
          </div>

          <div className="space-y-1.5 pt-0.5">
            <div className="flex items-baseline justify-between gap-2">
              <Skeleton className="h-2.5 w-12" />
              <Skeleton className="h-2.5 w-16" />
            </div>
            {/* The real meter, empty. Its 3px height and radius come from the
                stylesheet, so the row cannot drift from the card. */}
            <div className="st-meter" />
          </div>

          <div className="st-strip">
            <div className="st-strip-cell">
              <Skeleton className="h-2.5 w-10" />
              <Skeleton className="h-4 w-8" />
            </div>
            <div className="st-strip-cell">
              <Skeleton className="h-2.5 w-10" />
              <Skeleton className="h-4 w-8" />
            </div>
          </div>
        </div>
      ))}
    </>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd frontend && npx vitest run components/stats/KpiBento.test.tsx
```

Expected: PASS, three tests.

- [ ] **Step 5: Wire it into the Overview tab**

In `frontend/pages/Stats.tsx`, import it alongside the existing `KpiBento` imports:

```tsx
import { LeaderCard, TeamCard, MetricCard, KpiRowSkeleton } from '../components/stats/KpiBento'
```

Replace the whole gated block at lines 679 to 704. The gate keeps its meaning for the settled case -- a range with neither players nor games still shows nothing -- but the cold case now renders the skeleton instead of nothing at all:

```tsx
          {/* The three cards that open the page. On a cold load this row used
              to be absent from the DOM entirely and then appear above the
              leaderboard, pushing the whole page down -- the jolt this panel
              row exists to remove. It is inside Swap so the height settles
              rather than cutting, and inside Resolve so the skeleton cross
              fades into the cards rather than being swapped for them. */}
          {(rangePending || playerLines.length > 0 || gamesInFilter > 0) && (
            <Swap busy={rangePending && playerLines.length > 0}>
              <Resolve
                loading={rangePending && playerLines.length === 0}
                className="grid grid-cols-1 gap-3 md:grid-cols-3"
                skeleton={<KpiRowSkeleton count={3} />}
              >
                <LeaderCard
                  overline="Top finisher"
                  icon={<Trophy className="h-3.5 w-3.5" weight="bold" />}
                  series="goals"
                  player={topFinisher}
                  value={topFinisher?.goals ?? 0}
                  unit="Goals"
                  teamTotal={teamGoals}
                  secondary={secondaryFor('goals', topFinisher)}
                />
                <LeaderCard
                  overline="Top playmaker"
                  icon={<Handshake className="h-3.5 w-3.5" weight="bold" />}
                  series="assists"
                  player={topPlaymaker}
                  value={topPlaymaker?.assists ?? 0}
                  unit="Assists"
                  teamTotal={teamAssists}
                  secondary={secondaryFor('assists', topPlaymaker)}
                />
                <TeamCard icon={<Scales className="h-3.5 w-3.5" weight="bold" />} team={teamLine} />
              </Resolve>
            </Swap>
          )}
```

Note what left: the `<div className="ufwt-swap">` wrapper and the `<FadeIn>`. `Swap` now supplies the dim and the height, and `Resolve` supplies the entrance, so a separate `FadeIn` would be a second opinion about the same moment.

Add the two imports at the top of the file:

```tsx
import Swap from '../components/Swap'
import Resolve from '../components/Resolve'
```

- [ ] **Step 6: Check the grid class landed on the right element**

`Resolve` puts `className` on its outer box in both the loading and settled branches, so the three column grid applies to the skeleton and the cards alike. Confirm in the browser that the skeleton row is three across at `md` and up and one across below it, matching the cards.

- [ ] **Step 7: Run everything and commit**

```bash
cd frontend && npm test && npm run typecheck && npm run build
```

```bash
git add frontend/components/stats/KpiBento.tsx frontend/components/stats/KpiBento.test.tsx frontend/pages/Stats.tsx
git commit -m "Give the Stats KPI row a skeleton

The row was gated on having players or games in range, so on a cold load it was
absent from the DOM and then inserted above the leaderboard once data landed,
pushing the page down by about 170px. That is the jolt this started from.

The skeleton reuses .st-panel .st-kpi and the card's own inner classes, so it
stands as tall as what replaces it by construction rather than by a guessed
height that would drift the next time the card's padding changed."
```

---

### Task 9: The same fix for the Me tab

`pages/Stats.tsx:641` renders a single `Skeleton h-9` inside a panel, roughly 70px, then swaps it for an `<h2>` plus a three or four card grid, roughly 140px. Identical push down, one tab over.

**Files:**
- Modify: `frontend/pages/Stats.tsx:636-670`

**Interfaces:**
- Consumes: `KpiRowSkeleton` from Task 8, `Resolve` from Task 4.
- Produces: nothing new.

- [ ] **Step 1: Replace the statsArr gate**

At `pages/Stats.tsx`, the branch currently reading:

```tsx
          ) : statsArr === undefined ? (
            <section className="st-panel p-4">
              <Skeleton className="h-9 w-full" />
            </section>
          ) : mine ? (
```

Delete that branch entirely. The `mine` branch below now handles the pending case through `Resolve`, which removes the height mismatch rather than shrinking it.

- [ ] **Step 2: Rewrite the mine branch**

Replace the `mine` branch body with:

```tsx
          ) : mine || rangePending ? (
            <>
              {/* The heading is real as soon as there is a name for it, and a
                  skeleton only while there is not -- the page identifies
                  itself rather than showing four grey bars. */}
              {mine ? <h2 className="st-name text-lg">{mine.player_name}</h2> : <Skeleton className="h-6 w-40" />}
              <Swap busy={rangePending && mine != null}>
                <Resolve
                  loading={rangePending && mine == null}
                  className={`grid gap-3 ${SHOW_TURNOVERS ? 'grid-cols-2 lg:grid-cols-4' : 'grid-cols-1 sm:grid-cols-3'}`}
                  skeleton={<KpiRowSkeleton count={SHOW_TURNOVERS ? 4 : 3} />}
                >
                  <MetricCard label="Goals" value={mine?.goals ?? 0} series="goals" hint={mine ? perGame(mine.goals, mine.games_played) : undefined} />
                  <MetricCard label="Assists" value={mine?.assists ?? 0} series="assists" hint={mine ? perGame(mine.assists, mine.games_played) : undefined} />
                  {SHOW_TURNOVERS && (
                    <MetricCard label="Turnovers" value={mine?.turnovers ?? 0} series="turnovers" hint={mine ? perGame(mine.turnovers, mine.games_played) : undefined} />
                  )}
                  <MetricCard label="Games played" value={mine?.games_played ?? 0} />
                </Resolve>
              </Swap>
            </>
          ) : (
```

The `KpiRowSkeleton` count tracks `SHOW_TURNOVERS` for the same reason the grid does: with turnovers gated off the row is three cards, and a four card skeleton would leave a quarter of the row standing empty and then collapse.

- [ ] **Step 3: Verify the empty case still reads correctly**

The final `else` branch, "No stats yet for the current filter.", must now be reachable only when `rangePending` is false and `mine` is undefined. Confirm by loading the Me tab for a claimed player, then switching to a range with no games: the message appears, and no skeleton is left behind.

- [ ] **Step 4: Run everything and commit**

```bash
cd frontend && npm test && npm run typecheck && npm run build
```

```bash
git add frontend/pages/Stats.tsx
git commit -m "Give the Me tab the same cold load treatment

It rendered one 70px skeleton bar and then swapped it for a heading plus a card
grid about twice as tall, which is the same push down as the Overview row, one
tab over. The card count tracks SHOW_TURNOVERS so the skeleton does not reserve
a fourth card that never arrives."
```

---

### Task 10: The opponent history panel

`pages/Stats.tsx:998` renders the bare string "Loading..." where a list of rows is about to be.

**Files:**
- Modify: `frontend/pages/Stats.tsx:995-1002`

**Interfaces:**
- Consumes: `Resolve` from Task 4.
- Produces: nothing new.

- [ ] **Step 1: Replace the text with row shaped skeletons**

Change:

```tsx
        {oppHistoryLoading && !oppHistory ? (
          <p className="st-meta">Loading…</p>
        ) : (
```

to:

```tsx
        {oppHistoryLoading && !oppHistory ? (
          <div className="space-y-2" aria-hidden="true">
            {[0, 1, 2].map(i => (
              <div key={i} className="flex items-center gap-2.5">
                <Skeleton className="h-7 w-7 rounded-md" />
                <Skeleton className="h-3 flex-1" />
                <Skeleton className="h-3 w-10" />
              </div>
            ))}
          </div>
        ) : (
```

Three rows rather than a guess at the real count: this is a head to head strip inside a dialog, and over reserving is worse than under reserving in a box the user just opened.

- [ ] **Step 2: Verify in the app**

Open the League Standings tab, click a team to open the detail dialog, and watch the head to head section on a throttled connection. Expected: three skeleton rows, then the real rows. No "Loading..." string.

- [ ] **Step 3: Run everything and commit**

```bash
cd frontend && npm test && npm run typecheck && npm run build
```

```bash
git add frontend/pages/Stats.tsx
git commit -m "Replace the opponent history Loading string with row skeletons

The last centred Loading text on the Stats page. Three rows rather than a guess
at the real count, because over reserving inside a dialog the user just opened
is worse than under reserving."
```

---

### Task 11: Measure the fix

The spec's verification metric is CLS, measured over CDP against real headless Chrome. This task proves the jolt is gone rather than asserting it.

**Files:**
- Create: `scripts/measure-cls.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `node scripts/measure-cls.mjs <url> <label>` printing a JSON record with `cls`, `shifts`, `fcp_ms` and `lcp_ms`.

- [ ] **Step 1: Write the measurement script**

Create `scripts/measure-cls.mjs`. Four things about it are not optional and each one silently produces a wrong answer if dropped:

```js
// Cumulative Layout Shift for a cold, throttled load, over CDP against real
// headless Chrome.
//
// Four things here are load bearing:
//
// 1. No --virtual-time-budget. It runs timers but produces no rendering steps,
//    so rAF barely ticks, ResizeObserver never fires and layout-shift entries
//    never arrive. Every Swap reads as stuck at its old height and the run
//    reports a broken app that is not broken.
// 2. Observers are parked on a live reference. An unreferenced
//    PerformanceObserver is collectable, and over a long settle it does get
//    collected, after which the run reports nulls while
//    performance.getEntriesByType() shows the entries plainly.
// 3. DOM work is deferred until document.documentElement exists.
//    addScriptToEvaluateOnNewDocument runs before the document is parsed, so
//    touching documentElement throws and takes the rest of the script with it.
// 4. The tab is activated. A background tab suspends rAF even though painting
//    still happens.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const URL_TO_LOAD = process.argv[2]
const LABEL = process.argv[3] || 'run'
const SETTLE_MS = Number(process.argv[4] || 15000)

// Lighthouse Slow 4G, plus 4x CPU. At full speed the windows being measured
// barely exist and a regression is invisible.
const NET = { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 }

const INIT = `
(() => {
  const s = { fcp: null, lcp: null, cls: 0, shifts: [], keep: [] };
  window.__m = s;
  try {
    const po = new PerformanceObserver(l => {
      for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') s.fcp = e.startTime;
    });
    po.observe({ type: 'paint', buffered: true });
    s.keep.push(po);
    const lo = new PerformanceObserver(l => { for (const e of l.getEntries()) s.lcp = e.startTime; });
    lo.observe({ type: 'largest-contentful-paint', buffered: true });
    s.keep.push(lo);
    const co = new PerformanceObserver(l => {
      for (const e of l.getEntries()) {
        if (e.hadRecentInput) continue;
        s.cls += e.value;
        s.shifts.push({ t: Math.round(e.startTime), v: Number(e.value.toFixed(4)) });
      }
    });
    co.observe({ type: 'layout-shift', buffered: true });
    s.keep.push(co);
  } catch (e) {}
})();
`

const profile = mkdtempSync(join(tmpdir(), 'cls-'))
const port = 9400 + Math.floor(Math.random() * 300)
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--disable-background-networking', '--window-size=1400,900', 'about:blank',
], { stdio: 'ignore' })

const sleep = ms => new Promise(r => setTimeout(r, ms))
let wsUrl
for (let i = 0; i < 60 && !wsUrl; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`)
    if (r.ok) wsUrl = (await r.json()).webSocketDebuggerUrl
  } catch {}
  if (!wsUrl) await sleep(250)
}
if (!wsUrl) { console.error('chrome did not start'); process.exit(1) }

const ws = new WebSocket(wsUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let id = 0
const pending = new Map()
ws.onmessage = ev => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
  }
}
const send = (method, params = {}, sessionId) => {
  const msgId = ++id
  return new Promise((resolve, reject) => {
    pending.set(msgId, { resolve, reject })
    ws.send(JSON.stringify({ id: msgId, method, params, sessionId }))
  })
}

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Target.activateTarget', { targetId })
const S = (m, p) => send(m, p, sessionId)

await S('Page.enable')
await S('Network.enable')
await S('Runtime.enable')
await S('Network.setCacheDisabled', { cacheDisabled: true })
await S('Network.clearBrowserCache')
await S('Network.emulateNetworkConditions', NET)
await S('Emulation.setCPUThrottlingRate', { rate: 4 })
await S('Page.addScriptToEvaluateOnNewDocument', { source: INIT })
await S('Page.navigate', { url: URL_TO_LOAD })
await sleep(SETTLE_MS)

const { result } = await S('Runtime.evaluate', {
  expression: `JSON.stringify({
    fcp: (performance.getEntriesByName('first-contentful-paint')[0] || {}).startTime ?? null,
    lcp: (window.__m || {}).lcp ?? null,
    cls: performance.getEntriesByType('layout-shift').filter(e => !e.hadRecentInput).reduce((a, e) => a + e.value, 0),
    shifts: performance.getEntriesByType('layout-shift').filter(e => !e.hadRecentInput)
      .map(e => ({ t: Math.round(e.startTime), v: Number(e.value.toFixed(4)) })).slice(0, 12),
  })`,
  returnByValue: true,
})
const m = JSON.parse(result.value)
console.log(JSON.stringify({
  label: LABEL,
  url: URL_TO_LOAD,
  cls: Number(m.cls.toFixed(4)),
  fcp_ms: m.fcp == null ? null : Math.round(m.fcp),
  lcp_ms: m.lcp == null ? null : Math.round(m.lcp),
  shifts: m.shifts,
}, null, 2))

ws.close()
chrome.kill()
try { rmSync(profile, { recursive: true, force: true }) } catch {}
```

- [ ] **Step 2: Measure the branch against main**

Layout shift needs a signed in session with real data, so run this against the dev server while signed in, with the browser profile reused. Measure `main` first, then the branch:

```bash
git stash && cd frontend && npm run dev &
node scripts/measure-cls.mjs "http://localhost:5000/stats" before
git stash pop && node scripts/measure-cls.mjs "http://localhost:5000/stats" after
```

Expected: `before` shows one or more shift entries in the first few seconds, dominated by a single large value at the moment the KPI row appears. `after` shows `cls` at or very near 0 with no entry at that timestamp.

Record both JSON records in the PR body. If `after` is not near zero, the remaining entries name their own timestamps -- find which panel moved at that moment rather than adjusting the threshold.

- [ ] **Step 3: Commit and open the PR**

```bash
git add scripts/measure-cls.mjs
git commit -m "Add a CLS measurement script

Drives real headless Chrome over CDP on a cold throttled load. Four details in
it are load bearing and each one silently produces a wrong answer if dropped;
they are documented at the top of the file, because three of them cost a
debugging session apiece to find."

git push -u origin feat/stats-cold-load
gh pr create --title "Fix the Stats page cold load jolt" --body-file -
```

PR body:

```markdown
Second of five PRs from the app wide loading states design
(`docs/superpowers/specs/2026-09-13-app-wide-loading-states-design.md`). This is
the reported bug.

On a cold load of /stats the leaderboard appeared first and the KPI cards landed
above it a moment later, pushing it down. Two causes, both fixed here.

The page had no representation of "nothing has been requested yet". `useApiCall`
starts `loading` at false, and no fetch fires while the default season resolves
from three parallel queries, so `rangePending` was false with no data and every
panel read that as empty: the leaderboard rendered "No stats available yet"
before the page had asked for anything. Roster.tsx:1162 already had the right
gate; this uses the same one, extracted as a tested helper.

The KPI row had no skeleton at all. It was gated on having players or games in
range, so on a cold load it was absent from the DOM and then inserted above the
leaderboard. Its skeleton is built from the same `.st-panel .st-kpi` classes as
the real cards, so it stands as tall as what replaces it by construction.

Also fixes the same push down on the Me tab, and replaces the last centred
"Loading..." string on the page with row shaped skeletons.

Measured with `scripts/measure-cls.mjs` on a cold load at Slow 4G and 4x CPU:

<!-- paste the before and after JSON records here -->
```

---

## Self-Review

**Spec coverage for PRs 1 and 2.** Section 2's four items map to Tasks 2 through 5 (`Swap` promotion, CSS promotion, `Resolve`, `FadeIn`), with the reduced motion block folded into Tasks 3 and 4 where the classes are defined. Section 3's Stats rows map to Tasks 7 through 10: `rangePending`, `KpiSkeleton`, `MetricCardSkeleton` (delivered as `KpiRowSkeleton` with a `count`, see below), and opponent history. The verification section maps to Task 11. Sections 1, and the Schedule, Roster, Strategy, Chat, PublicTeams and dialog rows, are PRs 3 through 5 and are deliberately absent.

**One deliberate deviation from the spec.** The spec names two components, `KpiSkeleton` and `MetricCardSkeleton`. Both cards have the same outer anatomy and the Me tab differs only in card count, so this plan ships one `KpiRowSkeleton({ count })` instead. Two components would have been two things to keep in sync with one card design. Noted here so the spec and the plan do not read as contradicting each other.

**One deliberate addition.** Task 1 adds a test runner the spec does not mention, because the frontend has none and `Resolve` has three behaviours no screenshot can check. Flagged at the top of that task.

**Placeholder scan.** No TBD, TODO, "similar to Task N", or "add error handling" steps. Every code step carries the actual code. The one intentional blank is the before/after JSON in the PR body at Task 11, which is output that does not exist until the step runs.

**Type consistency.** `isRangePending` takes `{ settledStats, loading, readsPairings, pairingsLoading }` in Task 7 and is called with exactly those four in Step 5. `Resolve` takes `{ loading, skeleton, className, children }` in Task 4 and is called with those in Tasks 8, 9 and 10. `RESOLVE_MS` is exported in Task 4 and imported by its own test only. `KpiRowSkeleton({ count })` is defined in Task 8 and called with `count={3}` and `count={SHOW_TURNOVERS ? 4 : 3}` in Tasks 8 and 9. `setReducedMotion` is exported from `test/setup.ts` in Task 1 and imported in Task 4. `Swap`'s props are unchanged throughout.
