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
