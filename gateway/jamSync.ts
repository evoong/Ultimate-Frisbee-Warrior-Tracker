// Imports games from configured .ics calendar feeds (see calendar_sources
// table). Portable (raw fetch only, no Node APIs) so it runs identically
// from Cloudflare Workers' scheduled() trigger and from the Express/Vercel
// cron route.
//
// An organization is 1:1 with a calendar: each row in calendar_sources is
// one league's .ics feed, keyed by `organizer` (must match the value used
// in seasons.organizer for that league). Adding a second calendar is a
// database row (supabase-migrations/005_calendar_sources.sql), not a code
// change — this module loops over every enabled source.
//
// Dedup strategy (per source):
// 1. Exact match on games.jam_uid (the feed's stable per-event UID) — once
//    a game is linked, re-syncing just detects reschedules and updates it.
// 2. For games with no jam_uid yet (anything entered before this importer
//    existed, or created manually) in one of that organizer's seasons,
//    flag as a conflict instead of auto-creating a duplicate whenever an
//    existing game falls on the same date within CONFLICT_WINDOW_MINUTES
//    of the incoming event's start time.
// 3. Otherwise, auto-create — but only if exactly one of that organizer's
//    seasons has a date range covering the event date; ambiguous or
//    missing season assignment is also a conflict rather than a guess.
//
// See supabase-migrations/004_jam_calendar_sync.sql and
// 005_calendar_sources.sql for the schema this reads/writes
// (games.jam_uid, jam_sync_conflicts, calendar_sources).

export interface JamSyncConfig {
  supabaseUrl: string
  supabaseSecretKey: string
}

export interface JamSyncResult {
  sources: number
  fetched: number
  created: number
  updated: number
  alreadySynced: number
  conflicts: number
  errors: string[]
}

interface CalendarSource {
  organizer: string
  calendar_url: string
}

interface JamEvent {
  uid: string
  opponent: string | null
  date: string
  time: string
  location: string | null
}

const CONFLICT_WINDOW_MINUTES = 30

function unfoldIcs(text: string): string[] {
  const rawLines = text.replace(/\r\n/g, '\n').split('\n')
  const lines: string[] = []
  for (const line of rawLines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1)
    } else if (line.length > 0) {
      lines.push(line)
    }
  }
  return lines
}

function unescapeIcsText(value: string): string {
  return value.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\')
}

function toJamEvent(fields: Record<string, string>): JamEvent | null {
  const uid = fields.UID
  const dtstart = fields.DTSTART
  if (!uid || !dtstart) return null

  const match = dtstart.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/)
  if (!match) return null
  const [, y, mo, d, h, mi, s] = match

  const summary = fields.SUMMARY ? unescapeIcsText(fields.SUMMARY) : ''
  const vsMatch = summary.match(/\bvs\.?\s+(.+)$/i)
  const opponent = vsMatch ? vsMatch[1]!.trim() : null

  const location = fields.LOCATION ? unescapeIcsText(fields.LOCATION) : null

  return { uid, opponent, date: `${y}-${mo}-${d}`, time: `${h}:${mi}:${s}`, location }
}

function parseJamCalendar(icsText: string): JamEvent[] {
  const lines = unfoldIcs(icsText)
  const events: JamEvent[] = []
  let current: Record<string, string> | null = null

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      current = {}
      continue
    }
    if (line === 'END:VEVENT') {
      if (current) {
        const parsed = toJamEvent(current)
        if (parsed) events.push(parsed)
      }
      current = null
      continue
    }
    if (!current) continue

    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).split(';')[0]!.toUpperCase()
    current[key] = line.slice(colonIdx + 1)
  }

  return events
}

async function supabaseFetch(config: JamSyncConfig, path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${config.supabaseUrl}/rest/v1${path}`, {
    ...init,
    headers: {
      apikey: config.supabaseSecretKey,
      Authorization: `Bearer ${config.supabaseSecretKey}`,
      'Content-Type': 'application/json',
      ...(init?.headers as Record<string, string> | undefined),
    },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Supabase request failed (${res.status}) ${path}: ${text}`)
  }
  // Prefer: return=minimal (used on writes) responds 200/201/204 with an
  // empty body — only parse JSON when there's actually content to parse.
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return h! * 60 + m!
}

async function createConflict(config: JamSyncConfig, organizer: string, event: JamEvent, existingGameId: number | null, reason: string): Promise<void> {
  await supabaseFetch(config, '/jam_sync_conflicts', {
    method: 'POST',
    headers: { Prefer: 'return=minimal,resolution=ignore-duplicates' },
    body: JSON.stringify({
      jam_uid: event.uid,
      organizer,
      opponent: event.opponent ?? '(unrecognized event)',
      event_date: event.date,
      event_time: event.time,
      location: event.location,
      existing_game_id: existingGameId,
      reason,
    }),
  })
}

async function syncSource(
  config: JamSyncConfig,
  source: CalendarSource,
  allGames: any[],
  allSeasons: any[],
  knownConflictUids: Set<string>,
  result: JamSyncResult
): Promise<void> {
  const icsRes = await fetch(source.calendar_url)
  if (!icsRes.ok) throw new Error(`Failed to fetch ${source.organizer} calendar (${icsRes.status})`)
  const events = parseJamCalendar(await icsRes.text())
  result.fetched += events.length

  const orgSeasons = allSeasons.filter((s: any) => s.organizer === source.organizer)
  const orgSeasonIds = new Set(orgSeasons.map((s: any) => s.id))

  const gamesByUid = new Map<string, any>((allGames ?? []).filter((g: any) => g.jam_uid).map((g: any) => [g.jam_uid, g]))
  // A game with no season_id is ambiguous (could belong to any organizer),
  // so it's still treated as a duplicate candidate rather than assumed safe.
  const unlinkedGamesByDate = new Map<string, any[]>()
  for (const g of allGames ?? []) {
    if (g.jam_uid || !g.game_date) continue
    if (g.season_id != null && !orgSeasonIds.has(g.season_id)) continue
    if (!unlinkedGamesByDate.has(g.game_date)) unlinkedGamesByDate.set(g.game_date, [])
    unlinkedGamesByDate.get(g.game_date)!.push(g)
  }

  for (const event of events) {
    try {
      const linked = gamesByUid.get(event.uid)
      if (linked) {
        const changed =
          linked.opponent !== event.opponent ||
          linked.game_date !== event.date ||
          (linked.game_time ?? '').slice(0, 5) !== event.time.slice(0, 5)
        if (changed && event.opponent) {
          await supabaseFetch(config, `/games?id=eq.${linked.id}`, {
            method: 'PATCH',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ opponent: event.opponent, game_date: event.date, game_time: event.time }),
          })
          result.updated++
        } else {
          result.alreadySynced++
        }
        continue
      }

      if (knownConflictUids.has(event.uid)) {
        result.alreadySynced++
        continue
      }

      if (!event.opponent) {
        await createConflict(config, source.organizer, event, null, 'unparseable')
        result.conflicts++
        continue
      }

      const candidates = (unlinkedGamesByDate.get(event.date) ?? []).filter((g: any) => {
        if (!g.game_time) return true
        return Math.abs(timeToMinutes(g.game_time.slice(0, 5)) - timeToMinutes(event.time.slice(0, 5))) <= CONFLICT_WINDOW_MINUTES
      })
      if (candidates.length === 1) {
        await createConflict(config, source.organizer, event, candidates[0].id, 'possible_duplicate')
        result.conflicts++
        continue
      }
      if (candidates.length > 1) {
        await createConflict(config, source.organizer, event, null, 'multiple_candidates')
        result.conflicts++
        continue
      }

      // null end_date means open-ended (matches getDefaultJamSeasonId's
      // "active" check) — e.g. a season with no known end date yet still
      // covers any date on/after its start_date.
      const matchingSeasons = orgSeasons.filter(
        (s: any) => s.start_date && s.start_date <= event.date && (s.end_date == null || event.date <= s.end_date)
      )
      if (matchingSeasons.length !== 1) {
        await createConflict(config, source.organizer, event, null, matchingSeasons.length === 0 ? 'no_season_match' : 'multiple_season_match')
        result.conflicts++
        continue
      }

      await supabaseFetch(config, '/games', {
        method: 'POST',
        headers: { Prefer: 'return=minimal,resolution=ignore-duplicates' },
        body: JSON.stringify({
          season_id: matchingSeasons[0].id,
          opponent: event.opponent,
          game_date: event.date,
          game_time: event.time,
          jam_uid: event.uid,
        }),
      })
      result.created++
    } catch (err) {
      result.errors.push(`${source.organizer} ${event.uid}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

export async function runJamSync(config: JamSyncConfig): Promise<JamSyncResult> {
  const result: JamSyncResult = { sources: 0, fetched: 0, created: 0, updated: 0, alreadySynced: 0, conflicts: 0, errors: [] }

  const [sources, allGames, allSeasons, existingConflicts] = await Promise.all([
    supabaseFetch(config, '/calendar_sources?select=organizer,calendar_url&enabled=eq.true'),
    supabaseFetch(config, '/games?select=id,season_id,opponent,game_date,game_time,jam_uid'),
    supabaseFetch(config, '/seasons?select=id,organizer,start_date,end_date'),
    supabaseFetch(config, '/jam_sync_conflicts?select=jam_uid'),
  ])

  const knownConflictUids = new Set<string>((existingConflicts ?? []).map((c: any) => c.jam_uid))
  result.sources = (sources ?? []).length

  for (const source of (sources ?? []) as CalendarSource[]) {
    try {
      await syncSource(config, source, allGames ?? [], allSeasons ?? [], knownConflictUids, result)
    } catch (err) {
      result.errors.push(`${source.organizer}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return result
}
