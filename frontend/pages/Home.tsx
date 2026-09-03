import { useNavigate } from 'react-router-dom'
import {
  Calendar,
  Users,
  BarChart3,
  ClipboardList,
  MessageCircle,
  Moon,
  Sun,
  ArrowRight,
} from 'lucide-react'
import { Button } from '../lib/shadcn/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../lib/shadcn/card'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '../lib/shadcn/accordion'

const FEATURES = [
  {
    icon: Calendar,
    title: 'Live scoring',
    description:
      'A real-time scoreboard for logging goals and assists during a game, with an undo button and a full event log so nothing gets lost in the moment.',
  },
  {
    icon: Users,
    title: 'Roster & lineups',
    description:
      'Track every player and their status per season, build lineup groups, and reorder them by drag and drop. Attendance is derived automatically.',
  },
  {
    icon: BarChart3,
    title: 'Stats & standings',
    description:
      'Goals, assists, turnovers, and custom computed columns, sortable and filterable by season, plus league standings computed automatically from results.',
  },
  {
    icon: ClipboardList,
    title: 'Strategy board',
    description:
      'Diagram named plays step by step with player positions, opponent markers, and run/throw arrows, then step through them like an animation.',
  },
  {
    icon: MessageCircle,
    title: 'AI assistant',
    description:
      'Ask questions about your team’s stats in plain language, or let it log events and manage lineups for you once you confirm.',
  },
]

// These questions and answers must stay in sync with the FAQPage JSON-LD in
// frontend/index.html: answer engines treat visible content and structured
// data that disagree as low-trust, so both copies are kept as plain text
// here rather than sharing a build-time constant with the static HTML head.
const FAQS = [
  {
    q: 'Is Ultimate Frisbee Warrior Tracker free to use?',
    a: 'Yes. Signup is open, and any signed-in user can create a new team or join an existing one for free.',
  },
  {
    q: 'Can I track live scores during a game?',
    a: 'Yes. The Schedule page’s Events tab has a live scoreboard for logging goals and assists in real time, with an undo button for mistakes.',
  },
  {
    q: 'Does it support a whole league, not just one team?',
    a: 'Yes. An organization can run one team or several, and League Standings automatically tracks every team’s record, points, and point differential for a season as games are scored.',
  },
  {
    q: 'Can I diagram and animate strategy plays?',
    a: 'Yes. The Strategy board lets you build named plays step by step with player positions, opponent markers, and arrows, then step through them like a play-by-play animation.',
  },
  {
    q: 'Is there an AI assistant?',
    a: 'Yes. The built-in AI chat can answer questions about your team’s stats and, once you confirm, log events or manage lineups for you. The same tools are also available to external AI clients over MCP.',
  },
  {
    q: 'Do I need to install anything?',
    a: 'No. Ultimate Frisbee Warrior Tracker runs in the browser on desktop and mobile, with no app download required.',
  },
]

interface HomeProps {
  theme: 'light' | 'dark'
  toggleTheme: () => void
}

export default function Home({ theme, toggleTheme }: HomeProps) {
  const navigate = useNavigate()

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <span className="text-lg font-bold text-primary">Warrior Tracker</span>
          <div className="flex items-center gap-2">
            <button
              onClick={toggleTheme}
              className="p-2 rounded-lg hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
              aria-label="Toggle theme"
            >
              {theme === 'dark' ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            </button>
            <Button variant="outline" onClick={() => navigate('/login')}>
              Sign in
            </Button>
          </div>
        </div>
      </header>

      <main>
        <section className="max-w-5xl mx-auto px-4 sm:px-6 pt-16 pb-14 text-center">
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight text-balance">
            Run your Ultimate Frisbee team or league from one place
          </h1>
          <p className="mt-5 text-lg text-muted-foreground max-w-2xl mx-auto text-balance">
            Live game scoring, rosters and lineups, player stats, league standings, and a
            strategy board, built for team captains, coaches, and league organizers alike.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Button size="lg" onClick={() => navigate('/login?mode=signup')}>
              Get started free
              <ArrowRight className="w-4 h-4 ml-2" />
            </Button>
            <Button size="lg" variant="outline" onClick={() => navigate('/login')}>
              Sign in
            </Button>
          </div>
        </section>

        <section aria-labelledby="features-heading" className="max-w-5xl mx-auto px-4 sm:px-6 pb-16">
          <h2 id="features-heading" className="sr-only">
            Features
          </h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {FEATURES.map(({ icon: Icon, title, description }) => (
              <Card key={title}>
                <CardHeader>
                  <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center mb-2">
                    <Icon className="w-5 h-5 text-primary" />
                  </div>
                  <CardTitle className="text-base">{title}</CardTitle>
                </CardHeader>
                <CardContent>
                  <CardDescription>{description}</CardDescription>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        <section className="border-y border-border bg-accent/40">
          <div className="max-w-5xl mx-auto px-4 sm:px-6 py-14 grid sm:grid-cols-2 gap-8">
            <div>
              <h2 className="text-xl font-semibold">For team captains & coaches</h2>
              <p className="mt-2 text-muted-foreground">
                Score games live, keep one roster in sync across every season, build lineups in
                seconds, and see who&apos;s carrying the offense before your next matchup.
              </p>
            </div>
            <div>
              <h2 className="text-xl font-semibold">For league organizers</h2>
              <p className="mt-2 text-muted-foreground">
                Standings, points, and point differential are computed automatically from
                results, so your league table stays accurate without a separate spreadsheet.
              </p>
            </div>
          </div>
        </section>

        <section aria-labelledby="faq-heading" className="max-w-3xl mx-auto px-4 sm:px-6 py-16">
          <h2 id="faq-heading" className="text-2xl font-bold text-center mb-6">
            Frequently asked questions
          </h2>
          <Accordion type="single" collapsible>
            {FAQS.map(({ q, a }) => (
              <AccordionItem key={q} value={q}>
                <AccordionTrigger>{q}</AccordionTrigger>
                <AccordionContent>{a}</AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </section>

        <section className="max-w-5xl mx-auto px-4 sm:px-6 pb-20 text-center">
          <Button size="lg" onClick={() => navigate('/login?mode=signup')}>
            Create your team
            <ArrowRight className="w-4 h-4 ml-2" />
          </Button>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 text-sm text-muted-foreground text-center">
          Ultimate Frisbee Warrior Tracker
        </div>
      </footer>
    </div>
  )
}
