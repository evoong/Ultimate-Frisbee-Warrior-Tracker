import { useEffect } from 'react'

export function useGameEventPolling(gameId: number | null, fetchEvents: (params: { gameId: number }) => void) {
  useEffect(() => {
    if (gameId === null) return

    const refresh = () => {
      if (!document.hidden) fetchEvents({ gameId })
    }

    const intervalId = window.setInterval(refresh, 2_000)
    return () => window.clearInterval(intervalId)
  }, [gameId, fetchEvents])
}
