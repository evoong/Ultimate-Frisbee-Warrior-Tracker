import { Card, CardContent, CardHeader, CardTitle } from '../lib/shadcn/card'
import { AlertCircle } from 'lucide-react'

export default function Chat() {
  return (
    <div className="space-y-4">
      <Card className="border-amber-200 bg-amber-50">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-amber-900">
            <AlertCircle className="w-5 h-5" />
            Chat Feature Coming Soon
          </CardTitle>
        </CardHeader>
        <CardContent className="text-amber-800">
          <p>The AI chat feature requires a backend service and is not currently available in this deployment.</p>
          <p className="mt-2 text-sm">The app works fully for:</p>
          <ul className="list-disc list-inside mt-2 space-y-1 text-sm">
            <li>QuickScore - Track game events and scores</li>
            <li>Schedule - View and manage games</li>
            <li>Roster - Manage players</li>
            <li>Stats - View player statistics</li>
            <li>Ranking - Player rankings</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}
