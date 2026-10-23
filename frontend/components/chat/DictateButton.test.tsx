import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

class FakeRec {
  static last: FakeRec
  onresult: any
  onend: any
  constructor() { FakeRec.last = this }
  start() {}
  stop() { this.onend?.() }
  abort() {}
}

async function load() {
  vi.resetModules()
  return (await import('./DictateButton')).default
}

afterEach(() => { delete (window as any).SpeechRecognition })

describe('DictateButton', () => {
  it('renders nothing when the browser has no speech recognition', async () => {
    const DictateButton = await load()
    const { container } = render(<DictateButton value="" onChange={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('appends the transcript to existing text and stops on second click', async () => {
    ;(window as any).SpeechRecognition = FakeRec
    const DictateButton = await load()
    const onChange = vi.fn()
    render(<DictateButton value="who scored" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Dictate a message' }))
    FakeRec.last.onresult({ results: [[{ transcript: ' most goals' }]] })
    expect(onChange).toHaveBeenCalledWith('who scored most goals')
    fireEvent.click(screen.getByRole('button', { name: 'Stop dictation' }))
    expect(screen.getByRole('button', { name: 'Dictate a message' })).toBeInTheDocument()
  })
})
