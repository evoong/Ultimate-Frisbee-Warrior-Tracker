import { useMemo } from 'react'
import { crestInitials, shortName, type MatrixEdge, type PlayerLine } from './types'
import './stats-theme.css'

// The assist web: every connected player on a ring, every assist a curved
// line between two of them.
//
// An earlier pair of these graphs was removed for being a hairball, and the
// reasons were real: every edge was drawn at full strength in one colour, so
// twelve players' worth of lines crossed each other and their own labels, a
// count bubble floated on every line, and the two rings drew identical edges
// and differed only in which end counted as "yours". This is the same picture
// with those three problems fixed rather than a revival of it:
//
//   * Focus + dim, exactly as the progression chart does it. One player is
//     always focused -- the same selection the picker and the matrix columns
//     read -- their lines are drawn in full colour and everything else drops
//     to `--st-ink / 0.13`. The pack still carries the shape of the team,
//     which is the context that makes one player's lines worth following.
//   * Direction is colour, so one ring says what two used to. A line into
//     the focused player (somebody assisted their goal) is the goals green;
//     a line out of them (they threw the assist) is the assists violet --
//     the same two series colours the table's two columns take, so the web
//     and the table are the same statement in the same palette. That is also
//     why A->B and B->A stay two separate lines: they are two different facts
//     about the focused player, and merging them (which the old graph had to
//     do, because both were one colour) would fold one into the other.
//   * Only the focused player's lines carry a count and only their partners
//     carry a name. Everything a dimmed line has to say is "this pairing
//     exists".
//
// It takes `players`, `edges` and a selection and nothing else -- no query,
// no filter state -- the same boundary GameRow keeps against `games`.

const SIZE = 380
const CENTER = SIZE / 2
/** Ring radius. The remaining ~58px of the viewBox is the label margin: a
 *  name sits outside its node, not inside it, because a first name at 9px
 *  inside an 11px-radius circle was the old graph's other legibility bug. */
const RING = 112
const LABEL_GAP = 11
/** Perpendicular offset of each line from the straight chord, always taken
 *  on the same side of the from->to direction. That is what separates the
 *  two directions of a pair: the perpendicular flips with the line, so A->B
 *  and B->A bow to opposite sides on their own. Choosing a side by id order
 *  instead cancels that flip out and lays the two straight on top of each
 *  other -- which reads as one connection, the exact conflation the old
 *  merged-edge graph had to live with. */
const CURVE = 15

/** Greedy farthest-point placement: given items ranked most- to
 *  least-connected, slot 0 goes to the top item, then each next item takes
 *  whichever free slot is farthest (circularly) from every slot already
 *  claimed. Second-busiest lands opposite the busiest, third a quarter-turn
 *  from both, and so on, so the handful of heavily-connected nodes spread
 *  around the ring instead of clustering -- clustered hubs are what actually
 *  fills a small area with crossing lines. O(n^2), fine for a roster. */
function spreadOrder<T>(rankedDesc: T[]): T[] {
  const n = rankedDesc.length
  if (n === 0) return []
  const claimed: number[] = [0]
  for (let k = 1; k < n; k++) {
    let bestSlot = -1
    let bestMinDist = -1
    for (let s = 0; s < n; s++) {
      if (claimed.includes(s)) continue
      const minDist = Math.min(...claimed.map(u => Math.min(Math.abs(s - u), n - Math.abs(s - u))))
      if (minDist > bestMinDist) { bestMinDist = minDist; bestSlot = s }
    }
    claimed.push(bestSlot)
  }
  const out: T[] = new Array(n)
  claimed.forEach((slot, i) => { out[slot] = rankedDesc[i]! })
  return out
}

type WebNode = {
  id: number
  name: string
  label: string
  x: number
  y: number
  r: number
  angle: number
}

/** A name sits outside the ring with only the viewBox margin behind it, so
 *  it is bounded here rather than left to spill over the panel's border.
 *  shortName already caps the surname at an initial; this catches the long
 *  first name. The full name is on the node's <title> and aria-label. */
function fitLabel(short: string): string {
  return short.length > 12 ? `${short.slice(0, 11).trimEnd()}\u2026` : short
}

const BUBBLE_R = 7.5

/** Where along its own curve a count bubble may sit, best spot first, as a
 *  fraction of the way from the focused player to the partner (the
 *  placement below mirrors these for a line that arrives at the focus
 *  rather than leaving it).
 *
 *  Every lit line meets the focused player, so the midpoint -- the obvious
 *  place for a label -- is the one place they cannot go: eleven lines
 *  converge there, so eleven bubbles land on one small arc, overlapping each
 *  other and the hub. Out at the partner's end the lines have fanned apart,
 *  and a number sitting beside a face answers "whose number is this" without
 *  the eye having to trace a curve back to its other end. The candidates
 *  walk inward from there only as far as they have to. */
const BUBBLE_T = [0.76, 0.69, 0.83, 0.62, 0.88, 0.55, 0.48, 0.4]

type Pt = { x: number; y: number }

/** Point at `t` on a quadratic Bezier -- on the drawn line, not at the
 *  control point, which is off the curve entirely. */
function quadPoint(s: Pt, c: Pt, e: Pt, t: number): Pt {
  const u = 1 - t
  return {
    x: u * u * s.x + 2 * u * t * c.x + t * t * e.x,
    y: u * u * s.y + 2 * u * t * c.y + t * t * e.y,
  }
}

/** Where a line meets a node: pulled back off the centre so the arrowhead
 *  lands on the circumference rather than under the disc. */
function trim(from: { x: number; y: number }, toward: { x: number; y: number }, by: number) {
  const dx = toward.x - from.x
  const dy = toward.y - from.y
  const d = Math.hypot(dx, dy) || 1
  return { x: from.x + (dx / d) * by, y: from.y + (dy / d) * by }
}

export default function AssistWeb({ players, edges, selectedId, onSelect }: {
  players: PlayerLine[]
  edges: MatrixEdge[]
  selectedId: number | null
  onSelect: (id: number) => void
}) {
  const byId = useMemo(() => new Map(players.map(p => [p.playerId, p])), [players])

  const nodes = useMemo<WebNode[]>(() => {
    // Only players with a connection get a node, plus the focused player so
    // the selection always has somewhere to be. A lone unconnected dot on
    // the ring spends a slot to say nothing; the table's empty-column copy
    // says it in words instead.
    const degree = new Map<number, number>()
    edges.forEach(e => {
      if (!byId.has(e.assisterId) || !byId.has(e.scorerId)) return
      degree.set(e.assisterId, (degree.get(e.assisterId) ?? 0) + e.count)
      degree.set(e.scorerId, (degree.get(e.scorerId) ?? 0) + e.count)
    })
    if (selectedId != null && byId.has(selectedId) && !degree.has(selectedId)) degree.set(selectedId, 0)

    const ids = [...degree.keys()]
    if (ids.length === 0) return []
    const maxDegree = Math.max(1, ...degree.values())

    // Node size scales down as the ring fills rather than being capped at a
    // node count: at 24 players a fixed 17px radius has the discs touching,
    // and a cap would silently drop somebody's connections off the picture.
    const spacing = (2 * Math.PI * RING) / Math.max(ids.length, 1)
    const rBase = Math.min(17, Math.max(7, spacing * 0.38))

    const ranked = ids.sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0))
    return spreadOrder(ranked).map((id, i) => {
      const p = byId.get(id)!
      const angle = (i / ids.length) * 2 * Math.PI - Math.PI / 2
      const ratio = (degree.get(id) ?? 0) / maxDegree
      return {
        id,
        name: p.name,
        label: fitLabel(shortName(p.name)),
        x: CENTER + RING * Math.cos(angle),
        y: CENTER + RING * Math.sin(angle),
        r: rBase * (0.72 + 0.28 * ratio),
        angle,
      }
    })
  }, [edges, byId, selectedId])

  const posById = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes])

  // 'assists': the focused player threw it (violet, the assists series).
  // 'goals':   the focused player caught it (green, the goals series).
  // 'dim':     it does not involve them.
  const drawn = useMemo(() => {
    const rows = edges
      .filter(e => posById.has(e.assisterId) && posById.has(e.scorerId))
      .map(e => ({
        ...e,
        kind: e.assisterId === selectedId ? 'assists' as const
          : e.scorerId === selectedId ? 'goals' as const
            : 'dim' as const,
      }))
    // SVG has no z-index; paint order is the only stacking there is, so the
    // dimmed lines go down first and the focused ones on top of them.
    return rows.sort((a, b) => Number(a.kind !== 'dim') - Number(b.kind !== 'dim'))
  }, [edges, posById, selectedId])

  const ownMax = Math.max(1, ...drawn.filter(e => e.kind !== 'dim').map(e => e.count))
  const partners = useMemo(() => {
    const s = new Set<number>()
    drawn.forEach(e => {
      if (e.kind === 'assists') s.add(e.scorerId)
      if (e.kind === 'goals') s.add(e.assisterId)
    })
    return s
  }, [drawn])

  // Geometry once, so the three paint passes below all read the same curves
  // rather than each recomputing them from the node positions.
  const geom = useMemo(() => drawn.map(e => {
    const from = posById.get(e.assisterId)!
    const to = posById.get(e.scorerId)!
    const own = e.kind !== 'dim'
    const mx = (from.x + to.x) / 2
    const my = (from.y + to.y) / 2
    const dx = to.x - from.x
    const dy = to.y - from.y
    const len = Math.hypot(dx, dy) || 1
    const c = { x: mx + (-dy / len) * CURVE, y: my + (dx / len) * CURVE }
    // Trim toward the control point, not toward the other centre: the line
    // leaves and arrives along its own tangent, so on a bowed path the
    // arrowhead still points where the line actually goes.
    const start = trim(from, c, from.r + 1.5)
    const end = trim(to, c, to.r + (own ? 6.5 : 2))
    return {
      key: `${e.assisterId}-${e.scorerId}`,
      kind: e.kind,
      own,
      count: e.count,
      start,
      c,
      end,
      stroke: own ? `hsl(var(--st-${e.kind}))` : 'hsl(var(--st-ink) / 0.13)',
      width: own ? 1.5 + (e.count / ownMax) * 3 : 1,
      // A line the focused player caught arrives at them, so its crowded end
      // is `end`; one they threw leaves from `start`.
      hubAtEnd: e.kind === 'goals',
    }
  }), [drawn, posById, ownMax])

  // Bubble placement. Greedy and deterministic: busiest line first (its
  // number is the one most worth reading, so it gets first pick of the
  // clear spots), each taking the first candidate that clears every node
  // disc and every bubble already down. If a line is so hemmed in that no
  // candidate is clear -- a short edge between two adjacent nodes -- it
  // takes the roomiest one rather than defaulting back to the midpoint,
  // which is the spot most likely to be buried.
  const bubbles = useMemo(() => {
    const discs = nodes.map(n => ({ x: n.x, y: n.y, clear: n.r + BUBBLE_R + 2 }))
    const placed: Pt[] = []
    return [...geom]
      .filter(g => g.own)
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
      .map(g => {
        let best: Pt | null = null
        let bestClearance = -Infinity
        for (const raw of BUBBLE_T) {
          const p = quadPoint(g.start, g.c, g.end, g.hubAtEnd ? 1 - raw : raw)
          let clearance = Infinity
          for (const d of discs) clearance = Math.min(clearance, Math.hypot(p.x - d.x, p.y - d.y) - d.clear)
          for (const q of placed) clearance = Math.min(clearance, Math.hypot(p.x - q.x, p.y - q.y) - (BUBBLE_R * 2 + 1.5))
          if (clearance >= 0) { best = p; break }
          if (clearance > bestClearance) { bestClearance = clearance; best = p }
        }
        placed.push(best!)
        return { key: g.key, ...best!, count: g.count, stroke: g.stroke }
      })
  }, [geom, nodes])

  if (nodes.length === 0) return null

  return (
    <div className="st-web">
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="st-web-svg"
        role="img"
        aria-label="Assist web. Lines run from the assister to the scorer; the focused player's lines carry their count."
      >
        {/* Three passes, because svg has no z-index and paint order is the
            only stacking there is: every line, then every arrowhead, then
            every count. Drawn one group per edge instead, a line crossing
            an earlier edge would be painted straight through that edge's
            bubble -- the number would be legible or not depending on which
            pairing happened to come first out of the query. */}
        {geom.map(g => (
          <path
            key={g.key}
            className="st-web-edge"
            d={`M ${g.start.x} ${g.start.y} Q ${g.c.x} ${g.c.y} ${g.end.x} ${g.end.y}`}
            fill="none"
            stroke={g.stroke}
            strokeWidth={g.width}
            strokeLinecap="round"
          />
        ))}

        {/* An arrowhead rather than a marker element: markers would need one
            def per colour and the tangent is already computed here. */}
        {geom.filter(g => g.own).map(g => (
          <path key={`${g.key}-tip`} d={arrowHead(g.end, g.c)} fill={g.stroke} />
        ))}

        {bubbles.map(b => (
          <g key={`${b.key}-count`} className="st-web-edge">
            <circle
              cx={b.x}
              cy={b.y}
              r={BUBBLE_R}
              fill="hsl(var(--st-panel))"
              stroke={b.stroke}
              strokeWidth={1}
            />
            <text
              x={b.x}
              y={b.y}
              textAnchor="middle"
              dominantBaseline="central"
              className="st-web-count"
              fill={b.stroke}
            >
              {b.count}
            </text>
          </g>
        ))}

        {nodes.map(n => {
          const focused = n.id === selectedId
          const linked = focused || partners.has(n.id)
          // Right half anchors its label outward from the node, left half
          // inward, so a name always grows away from the ring's centre.
          const cos = Math.cos(n.angle)
          const anchor = Math.abs(cos) < 0.25 ? 'middle' : cos > 0 ? 'start' : 'end'
          const lx = n.x + Math.cos(n.angle) * (n.r + LABEL_GAP)
          const ly = n.y + Math.sin(n.angle) * (n.r + LABEL_GAP)
          return (
            <g
              key={n.id}
              className="st-web-node"
              data-focused={focused}
              role="button"
              tabIndex={0}
              aria-pressed={focused}
              aria-label={`${n.name}. Show their assist connections.`}
              onClick={() => onSelect(n.id)}
              onKeyDown={ev => {
                if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onSelect(n.id) }
              }}
            >
              <title>{n.name}</title>
              {/* Hit area, so a 7px node on a filled ring is still a real
                  tap target on a phone. */}
              <circle cx={n.x} cy={n.y} r={n.r + 7} fill="transparent" />
              <circle
                cx={n.x}
                cy={n.y}
                r={n.r}
                fill={focused ? 'hsl(var(--st-accent-wash) / 0.14)' : 'hsl(var(--st-panel))'}
                stroke={focused ? 'hsl(var(--st-accent))' : linked ? 'hsl(var(--st-ink) / 0.4)' : 'hsl(var(--st-rule-strong))'}
                strokeWidth={focused ? 2 : 1}
              />
              <text
                x={n.x}
                y={n.y}
                textAnchor="middle"
                dominantBaseline="central"
                className="st-web-mono"
                fill={linked ? 'hsl(var(--st-ink))' : 'hsl(var(--st-ink-faint))'}
              >
                {crestInitials(n.name)}
              </text>
              {linked && (
                <text
                  x={lx}
                  y={ly}
                  textAnchor={anchor}
                  dominantBaseline="central"
                  className="st-web-label"
                  fill={focused ? 'hsl(var(--st-ink))' : 'hsl(var(--st-ink-mid))'}
                >
                  {n.label}
                </text>
              )}
            </g>
          )
        })}
      </svg>

      <div className="st-web-key">
        <span className="st-assists">
          <span className="st-web-swatch" />
          Assisted to
        </span>
        <span className="st-goals">
          <span className="st-web-swatch" />
          Assisted by
        </span>
        <span className="st-web-hint">Tap a player to focus them</span>
      </div>
    </div>
  )
}

/** A small filled triangle at `tip`, pointing away from `from`. */
function arrowHead(tip: { x: number; y: number }, from: { x: number; y: number }): string {
  const dx = tip.x - from.x
  const dy = tip.y - from.y
  const d = Math.hypot(dx, dy) || 1
  const ux = dx / d
  const uy = dy / d
  const len = 7
  const half = 3.2
  const bx = tip.x - ux * len
  const by = tip.y - uy * len
  return `M ${tip.x} ${tip.y} L ${bx - uy * half} ${by + ux * half} L ${bx + uy * half} ${by - ux * half} Z`
}
