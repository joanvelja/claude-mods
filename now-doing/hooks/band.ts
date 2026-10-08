// The band's layout as pure functions: which rows a view yields, in what order,
// and which give way when rows are short. register.tsx turns them into elements.
import type { NowDoingAsk, NowDoingBrief, NowDoingError, NowDoingPlan, NowDoingWorker, ShownState } from '../types'
import { clip, duration, isSpendCommand } from './digest'

export const STALL_MS = 600_000
export const SILENT_MS = 600_000

export type Color = 'warning' | 'success' | 'error' | 'claude' | 'subtle'
export type Part = { text: string; bold?: boolean; dim?: boolean; color?: Color }
/** A row: `parts` from the left, cut at the room left; `tail`, when given, held whole at the right edge. */
export type Row = { key: string; parts: Part[]; tail?: Part[]; priority: number; order: number }

export type View = {
  now: number
  isExpanded: boolean
  mission: string | null
  brief: NowDoingBrief | null
  openAsks: NowDoingAsk[]
  state: ShownState | null
  stateAt: number
  plan: NowDoingPlan | null
  workers: NowDoingWorker[]
  agentNow: Record<string, string>
  inputAt: number | null
  error: NowDoingError | null
}

/**
 * At most the cells `text` takes: every non-ASCII character counted as two.
 * Only for deciding what to leave out; Ink measures what is drawn.
 */
export const mostCells = (text: string) => [...text].reduce((n, c) => n + (c.codePointAt(0)! > 0x7f ? 2 : 1), 0)

const mostCellsOf = (parts: Part[]) => mostCells(parts.map(p => p.text).join(''))

/** `text` cut to at most `width` cells, an ellipsis marking the cut. */
function cut(text: string, width: number): string {
  if (mostCells(text) <= width) return text
  let out = ''
  for (const c of text) {
    if (mostCells(`${out + c}…`) > width) break
    out += c
  }
  return `${out}…`
}

// ── The title edge ──────────────────────────────────────────────────────────

const LOOK: Record<ShownState, { text: string; color: Color }> = {
  waiting: { text: '⏸ waiting on you', color: 'warning' },
  working: { text: '▶ working', color: 'claude' },
  stuck: { text: '⚠ stuck', color: 'error' },
  errored: { text: '⚠ errored', color: 'error' },
  done: { text: '✓ done', color: 'success' },
}

const OUTCOME_MARK = { ok: '✓', failed: '✗', unknown: '?' } as const
const MARK_COLOR = { ok: 'success', failed: 'error', unknown: undefined } as const

/**
 * The top border in pieces Ink places one by one: the head, a run of `─` it
 * sizes to what is left, the state's words, and the corner. The corner is
 * its own piece so that a glyph Ink counts wider than the terminal draws it
 * (⏸ ▶ ⚠ ⚡) cannot pull it off the card's right edge.
 */
export type Title = { head: Part[]; right: Part[]; corner: Part }

/** Cells of the border the filler always keeps. */
const MIN_FILL = 1

/**
 * The card's top border: `╭─ now-doing ───── ▶ working · 3m · 2 open asks ─╮`.
 * The open asks are counted in the state's words while waiting, after the
 * time otherwise. What may not fit in `width`, counted at most, leaves in
 * this order: the glyphs, the time, the count, then the state's words are cut.
 */
export function titleEdge(v: View, width: number, glyphs: Part[]): Title {
  const head: Part[] = [{ text: '╭─ ', color: 'subtle' }, { text: 'now-doing', color: 'claude' }, { text: ' ', color: 'subtle' }]
  const corner: Part = { text: ' ─╮', color: 'subtle' }
  const n = v.openAsks.length
  const counted = `${n} open ask${n === 1 ? '' : 's'}`
  const isWaiting = v.state === 'waiting' && n > 0
  const look = !v.state ? null : isWaiting ? { ...LOOK.waiting, text: `⏸ ${counted}` } : LOOK[v.state]
  const state: Part[] = look ? [{ text: ' ' }, { text: look.text, color: look.color }] : []
  const time: Part[] = look ? [{ text: ` · ${duration(v.now - v.stateAt)}`, dim: true }] : []
  const count: Part[] = look && n > 0 && !isWaiting ? [{ text: ` · ${counted}`, color: 'warning' }] : []
  const marks: Part[] = glyphs.length ? [{ text: look ? ' · ' : ' ', dim: true }, ...glyphs] : []
  const mid: Part[][] = [[...state, ...time, ...count, ...marks], [...state, ...time, ...count], [...state, ...count], state]
  const room = width - mostCellsOf(head) - MIN_FILL - mostCells(corner.text)
  const fits = mid.find(m => mostCellsOf(m) <= room)
  const chosen = fits ?? (look && room > 2 ? [{ text: ' ' }, { text: cut(look.text, room - 1), color: look.color }] : [])
  return { head, right: chosen, corner }
}

// ── Rows ────────────────────────────────────────────────────────────────────

const LABEL_WIDTH = 7

const labelled = (key: string, label: string, parts: Part[], priority: number, order: number): Row => ({
  key,
  parts: [{ text: `${label.padEnd(LABEL_WIDTH)} `, dim: true }, ...parts],
  priority,
  order,
})

function errorRow(v: View): Row | undefined {
  const err = v.error
  if (err?.kind === 'config') return labelled('error', '', [{ text: `⚠ summary stopped: ${err.reason} (/now-doing retries)`, color: 'warning' }], 3, 0)
  if (err && v.now - err.since >= STALL_MS) {
    return labelled('error', '', [{ text: `⚠ summary stalled ${duration(v.now - err.since)}: ${err.reason}`, color: 'warning' }], 3, 0)
  }
  return undefined
}

const COLLAPSED_ASKS = 3
const ASK_AGE_SHOWN_MS = 30 * 60_000

/** An ask's stable mark: the agent's own label when it gave one ("Q3"), else its number ("#7"). */
/** The agent's own label ("Q3.") when it gave one, else a bullet: the plugin's internal ids mean nothing to the person. */
export const askMark = (ask: NowDoingAsk) => (ask.label ? `${ask.label}.` : '•')

/** Open asks oldest first: by when they opened, then by id. */
export const oldestFirst = (asks: readonly NowDoingAsk[]) => [...asks].sort((a, b) => a.askedAt - b.askedAt || Number(a.id.slice(1)) - Number(b.id.slice(1)))

/**
 * Up to `room` open asks, oldest first, each with its stable mark and, when
 * old, its age; when not all fit, the last row counts the newer ones left out.
 */

function askRows(v: View, room: number): Row[] {
  const all = oldestFirst(v.openAsks)
  const shown = all.slice(0, Math.max(0, room))
  return shown.map((ask, i) => {
    const age = v.now - ask.askedAt
    const parts: Part[] = [{ text: `${askMark(ask)} ${ask.text}`, bold: true }]
    if (age > ASK_AGE_SHOWN_MS) parts.push({ text: ` (${duration(age)})`, dim: true })
    if (i === shown.length - 1 && all.length > shown.length) parts.push({ text: ` (+${all.length - shown.length} newer)`, dim: true })
    return labelled(`ask-${i}`, i === 0 ? 'ask' : '', parts, i, 2 + i)
  })
}

const runningShells = (v: View) => v.workers.filter(w => w.kind === 'shell' && w.finishedAt === undefined && isSpendCommand(w.command ?? ''))

function spendRow(v: View): Row | undefined {
  const said = v.brief?.spend
  const jobs = runningShells(v).map(w => `${clip(w.description, 40)} ${duration(v.now - w.startedAt)}`)
  const items = [...(said ? [said] : []), ...jobs]
  if (items.length === 0) return undefined
  return labelled('spend', 'spend', [{ text: '⚡ ', color: 'warning' }, { text: items.join(' · ') }], 5, 5)
}

function foundRow(v: View): Row | undefined {
  const found = (v.brief?.found ?? []).filter(f => v.inputAt === null || f.t > v.inputAt)
  if (found.length === 0) return undefined
  return labelled('found', 'found', [{ text: found.map(f => f.text).reverse().join(' · ') }], 6, 6)
}

function nextRow(v: View, priority: number): Row | undefined {
  const next = v.brief?.next ?? []
  return next.length ? labelled('next', 'next', [{ text: next.join(' → ') }], priority, 7) : undefined
}

function planRow(v: View): Row | undefined {
  const p = v.plan
  if (!p) return undefined
  const width = Math.min(p.total, 10)
  const filled = Math.round((p.done / p.total) * width)
  return labelled('plan', 'plan', [
    { text: '▰'.repeat(filled), color: 'claude' },
    { text: '▱'.repeat(width - filled), dim: true },
    { text: ` ${p.done}/${p.total}` },
    ...(p.current ? [{ text: ` · ${p.current}` }] : []),
  ], 8, 8)
}

const missionRow = (v: View): Row | undefined => (v.mission ? labelled('mission', 'mission', [{ text: v.mission }], 4, 1) : undefined)

// ── The worker tree ─────────────────────────────────────────────────────────

function treeOrder(workers: NowDoingWorker[]): { worker: NowDoingWorker; depth: number }[] {
  const ids = new Set(workers.map(w => w.id))
  const rank = (w: NowDoingWorker) => (w.finishedAt === undefined ? [0, w.startedAt] : [1, w.finishedAt])
  const sorted = [...workers].sort((a, b) => rank(a)[0]! - rank(b)[0]! || rank(a)[1]! - rank(b)[1]!)
  const out: { worker: NowDoingWorker; depth: number }[] = []
  const walk = (parentId: string | undefined, depth: number) => {
    for (const w of sorted) {
      const isRoot = w.parentId === undefined || !ids.has(w.parentId)
      if (parentId === undefined ? isRoot : w.parentId === parentId) {
        out.push({ worker: w, depth })
        walk(w.id, depth + 1)
      }
    }
  }
  walk(undefined, 0)
  return out
}

function statusParts(w: NowDoingWorker, now: number): Part[] {
  if (w.finishedAt !== undefined) {
    const outcome = w.outcome ?? 'unknown'
    return [{ text: `   ${OUTCOME_MARK[outcome]}`, color: MARK_COLOR[outcome], dim: outcome === 'unknown' }]
  }
  const running: Part = { text: `   ● ${duration(now - w.startedAt)}`, color: 'claude' }
  // A shell, or an agent whose transcript was never read: nothing is known of its activity.
  if (w.seen === undefined) return [running]
  const quiet = now - w.activeAt
  return [running, quiet >= SILENT_MS ? { text: ` · ⚠ silent ${duration(quiet)}`, color: 'warning' } : { text: ` · active ${duration(quiet)}`, dim: true }]
}

function treeRows(v: View, room: number): Row[] {
  const ordered = treeOrder(v.workers)
  if (room <= 0 || ordered.length === 0) return []
  const shown = ordered.length > room ? ordered.slice(0, room - 1) : ordered
  const hidden = ordered.slice(shown.length)
  const labelWidth = Math.min(12, Math.max(...shown.map(s => s.worker.label.length)))
  const rows: Row[] = shown.map(({ worker, depth }, i) => {
    const isLast = i === shown.length - 1 && hidden.length === 0
    const left = `${'  '.repeat(depth)}${isLast ? '└' : '├'} ${clip(worker.label, labelWidth).padEnd(labelWidth)}  `
    const said = v.agentNow[worker.id] ?? worker.description
    return { key: `w-${worker.id}`, parts: [{ text: left, dim: true }, { text: said }], tail: statusParts(worker, v.now), priority: 10 + i, order: 10 + i }
  })
  if (hidden.length > 0) {
    const done = hidden.filter(h => h.worker.finishedAt !== undefined).length
    rows.push({ key: 'more', parts: [{ text: `└ +${hidden.length} more (${done} done)`, dim: true }], priority: 10 + shown.length, order: 10 + shown.length })
  }
  return rows
}

/** One glyph per worker, for the collapsed title. */
const glyphParts = (v: View): Part[] =>
  treeOrder(v.workers).map(({ worker }) =>
    worker.finishedAt === undefined
      ? { text: '●', color: 'claude' as const }
      : { text: OUTCOME_MARK[worker.outcome ?? 'unknown'], color: MARK_COLOR[worker.outcome ?? 'unknown'] },
  )

// ── The band ────────────────────────────────────────────────────────────────

export type Band = { title: Title; rows: Row[] }

const COLLAPSED_ROWS = 3

/**
 * The card for a view `width` cells wide with `maxRows` rows, its borders
 * included. Rows give way by priority: asks first, then the summarizer's
 * error, mission, spend, found, next, plan and the tree. While the person
 * types it collapses to the asks and mission, or mission and next.
 */
export function bandRows(v: View, width: number, maxRows: number): Band {
  const room = maxRows - 2
  const by = (rows: (Row | undefined)[]) => rows.filter((r): r is Row => r !== undefined).sort((a, b) => a.priority - b.priority)
  const byOrder = (rows: Row[]) => [...rows].sort((a, b) => a.order - b.order)

  if (!v.isExpanded) {
    // The error row, when there is one, keeps its seat: the asks shown and their "(+k newer)" fit around it.
    const asks = askRows(v, Math.min(COLLAPSED_ASKS, Math.min(COLLAPSED_ROWS, room) - (errorRow(v) ? 1 : 0)))
    const rows = by([...asks, errorRow(v), missionRow(v), asks.length ? undefined : nextRow(v, 5)]).slice(0, Math.min(COLLAPSED_ROWS, room))
    return { title: titleEdge(v, width, glyphParts(v)), rows: byOrder(rows) }
  }

  const asks = askRows(v, room - (errorRow(v) ? 1 : 0))
  const heads = by([...asks, errorRow(v), missionRow(v), spendRow(v), foundRow(v), nextRow(v, 7), planRow(v)]).slice(0, room)
  return { title: titleEdge(v, width, []), rows: byOrder([...heads, ...treeRows(v, room - heads.length)]) }
}
