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

// Sentry Cron Monitor config for runJamSync's two automated call sites
// (server/index.ts's GET /api/cron/sync-jam, worker.ts's scheduled()).
// Kept here, once, as plain data — no Sentry import in this file, so this
// module stays portable across both runtimes per the note above — so the
// schedule can't drift out of sync between the two call sites or with the
// matching crontab entries in vercel.json's "crons" and wrangler.jsonc's
// "triggers.crons". Both call sites use the same monitor slug: a check-in
// from either platform counts as "the job ran today," and Sentry only
// flags it if neither one fires.
export const JAM_SYNC_MONITOR_SLUG = "jam-sync"
export const JAM_SYNC_MONITOR_CONFIG = {
  schedule: { type: "crontab" as const, value: "0 10 * * *" },
  checkinMargin: 10,
  maxRuntime: 10,
  timezone: "UTC",
}

interface CalendarSource {
  organizer: string
  calendar_url: string
  organization_id: number
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

// Feeds are inconsistent about timezone: Jam emits floating local time
// (DTSTART;TZID=America/Toronto:...), RHUC emits UTC (DTSTART:...Z). Both are
// normalized to America/Toronto local date/time so game_time stays
// comparable to manually-entered games and across sources.
function utcToToronto(y: string, mo: string, d: string, h: string, mi: string, s: string): { date: string; time: string } {
  const utcDate = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)))
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(utcDate)
  const get = (type: string) => parts.find((p) => p.type === type)!.value
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}:${get('second')}` }
}

function toJamEvent(fields: Record<string, string>): JamEvent | null {
  const uid = fields.UID
  const dtstart = fields.DTSTART
  if (!uid || !dtstart) return null

  const match = dtstart.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?/)
  if (!match) return null
  const [, y, mo, d, h, mi, s, isUtc] = match
  const { date, time } = isUtc ? utcToToronto(y!, mo!, d!, h!, mi!, s!) : { date: `${y}-${mo}-${d}`, time: `${h}:${mi}:${s}` }

  const summary = fields.SUMMARY ? unescapeIcsText(fields.SUMMARY) : ''
  const vsMatch = summary.match(/\bvs\.?\s+(.+)$/i)
  const opponent = vsMatch ? vsMatch[1]!.trim().replace(/\s*\((?:home|away)\)\s*$/i, '').trim() : null

  const location = fields.LOCATION ? unescapeIcsText(fields.LOCATION) : null

  return { uid, opponent, date, time, location }
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

async function createConflict(config: JamSyncConfig, organizationId: number, organizer: string, event: JamEvent, existingGameId: number | null, reason: string): Promise<void> {
  await supabaseFetch(config, '/jam_sync_conflicts', {
    method: 'POST',
    headers: { Prefer: 'return=minimal,resolution=ignore-duplicates' },
    body: JSON.stringify({
      organization_id: organizationId,
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
        await createConflict(config, source.organization_id, source.organizer, event, null, 'unparseable')
        result.conflicts++
        continue
      }

      const candidates = (unlinkedGamesByDate.get(event.date) ?? []).filter((g: any) => {
        if (!g.game_time) return true
        return Math.abs(timeToMinutes(g.game_time.slice(0, 5)) - timeToMinutes(event.time.slice(0, 5))) <= CONFLICT_WINDOW_MINUTES
      })
      if (candidates.length === 1) {
        await createConflict(config, source.organization_id, source.organizer, event, candidates[0].id, 'possible_duplicate')
        result.conflicts++
        continue
      }
      if (candidates.length > 1) {
        await createConflict(config, source.organization_id, source.organizer, event, null, 'multiple_candidates')
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
        await createConflict(config, source.organization_id, source.organizer, event, null, matchingSeasons.length === 0 ? 'no_season_match' : 'multiple_season_match')
        result.conflicts++
        continue
      }

      await supabaseFetch(config, '/games', {
        method: 'POST',
        headers: { Prefer: 'return=minimal,resolution=ignore-duplicates' },
        body: JSON.stringify({
          organization_id: source.organization_id,
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

export interface JamSyncOptions {
  /** When present, only these teams are synced. Omitted on the cron path,
   *  which legitimately covers every team that has a calendar source. */
  teamIds?: number[]
}

export async function runJamSync(
  config: JamSyncConfig,
  options: JamSyncOptions = {}
): Promise<JamSyncResult> {
  const result: JamSyncResult = { sources: 0, fetched: 0, created: 0, updated: 0, alreadySynced: 0, conflicts: 0, errors: [] }

  // PRESENCE of teamIds decides filtered vs unfiltered; its CONTENTS only
  // decide which teams. Absent is the cron path, which legitimately syncs every
  // team that has a calendar source. Present means the caller resolved to a
  // specific set, so anything that does not survive validation must sync
  // NOTHING -- never everything. Collapsing "provided but empty after
  // coercion" back to unfiltered would turn an empty allow-list into a
  // full-access grant, which is the whole hazard this filter exists to remove.
  let scope = ''
  if (options.teamIds) {
    // Coerced because these ids are interpolated into a PostgREST query
    // string. They come from our own database, but they arrive via JSON, where
    // the number type is a compile-time claim rather than a runtime guarantee.
    const teamIds = options.teamIds.map(Number).filter(Number.isInteger)
    if (teamIds.length === 0) return result
    scope = `&organization_id=in.(${teamIds.join(',')})`
  }

  // Every one of these is scoped, not just calendar_sources. syncSource matches
  // games by jam_uid across whatever it is handed, so an unscoped games fetch
  // would let a uid shared between two teams (a common league feed) update the
  // other team's row -- a cross-team write that filtering only the sources
  // would leave wide open.
  const [sources, allGames, allSeasons, existingConflicts] = await Promise.all([
    supabaseFetch(config, `/calendar_sources?select=organizer,calendar_url,organization_id&enabled=eq.true${scope}`),
    supabaseFetch(config, `/games?select=id,season_id,opponent,game_date,game_time,jam_uid${scope}`),
    supabaseFetch(config, `/seasons?select=id,organizer,start_date,end_date${scope}`),
    supabaseFetch(config, `/jam_sync_conflicts?select=jam_uid${scope}`),
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
