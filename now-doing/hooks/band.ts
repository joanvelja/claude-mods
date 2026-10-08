// The band's layout as pure functions: which rows a view yields, in which block,
// and which give way when rows are short. register.tsx turns them into elements.
import type { NowDoingAsk, NowDoingBrief, NowDoingError, NowDoingFound, NowDoingPlan, NowDoingWorker, ShownState } from '../types'
import { clip, duration, isSpendCommand } from './digest'

export const STALL_MS = 600_000
export const SILENT_MS = 600_000

/** The header strip's tint: the theme's own key for a sent prompt's background, so it follows light and dark themes. */
export const HEADER_BG = 'userMessageBackground'

export type Color = 'warning' | 'success' | 'error' | 'claude' | 'subtle'
export type Part = { text: string; bold?: boolean; dim?: boolean; color?: Color }
/** A row: `parts` from the left, cut at the room left; `tail`, when given, held whole at the right edge. */
export type Row = { key: string; parts: Part[]; tail?: Part[] }

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
  return `${out.trimEnd()}…`
}

// ── The header ──────────────────────────────────────────────────────────────

// Glyphs Ink and terminals agree are one cell wide (⏸ ▶ ⚠ are not), so the tint ends at the edge.
const LOOK: Record<ShownState, { text: string; color: Color }> = {
  waiting: { text: '◆ waiting on you', color: 'warning' },
  working: { text: '▸ working', color: 'claude' },
  stuck: { text: '▲ stuck', color: 'error' },
  errored: { text: '✗ errored', color: 'error' },
  done: { text: '✓ done', color: 'success' },
}

const OUTCOME_MARK = { ok: '✓', failed: '✗', unknown: '?' } as const
const MARK_COLOR = { ok: 'success', failed: 'error', unknown: undefined } as const

/** The tinted strip: `left` held whole, `right` (the mission, or the summarizer's error) cut to what is left. */
export type Header = { left: Part[]; right: Part[] }

const HEAD: Part[] = [{ text: ' now-doing', color: 'claude', bold: true }]

/** The summarizer's trouble, when it should be seen: a stop at once, a stall after STALL_MS. */
function errorText(v: View): string | undefined {
  const err = v.error
  if (err?.kind === 'config') return `⚠ summary stopped: ${err.reason} (/now-doing retries)`
  if (err && v.now - err.since >= STALL_MS) return `⚠ summary stalled ${duration(v.now - err.since)}: ${err.reason}`
  return undefined
}

/**
 * ` now-doing  ▸ working · 3m · 2 open asks   the mission…`. The open asks
 * are counted in the state's words while waiting, after the time otherwise.
 * The mission gives way first; then, counted at most, the glyphs, the time,
 * the count, and last the state's words are cut.
 */
export function header(v: View, width: number, glyphs: Part[]): Header {
  const n = v.openAsks.length
  const counted = `${n} open ask${n === 1 ? '' : 's'}`
  const isWaiting = v.state === 'waiting' && n > 0
  const look = !v.state ? null : isWaiting ? { ...LOOK.waiting, text: `◆ ${counted}` } : LOOK[v.state]
  const state: Part[] = look ? [{ text: '  ' }, { text: look.text, color: look.color, bold: true }] : []
  const time: Part[] = look ? [{ text: ` · ${duration(v.now - v.stateAt)}`, dim: true }] : []
  const count: Part[] = look && n > 0 && !isWaiting ? [{ text: ` · ${counted}`, color: 'warning' }] : []
  const marks: Part[] = glyphs.length ? [{ text: look ? ' · ' : '  ', dim: true }, ...glyphs] : []
  const mid: Part[][] = [[...state, ...time, ...count, ...marks], [...state, ...time, ...count], [...state, ...count], state]
  const room = width - mostCellsOf(HEAD) - 1
  const fits = mid.find(m => mostCellsOf(m) <= room)
  const chosen = fits ?? (look && room > 3 ? [{ text: '  ' }, { text: cut(look.text, room - 2), color: look.color, bold: true }] : [])
  const err = errorText(v)
  const right: Part[] = err ? [{ text: '   ' }, { text: err, color: 'warning' }] : v.mission ? [{ text: '   ' }, { text: v.mission, dim: true }] : []
  return { left: [...HEAD, ...chosen], right }
}

// ── Asks ────────────────────────────────────────────────────────────────────

/** An ask younger than this shows no age: only the old ones need pointing out. */
const ASK_AGE_SHOWN_MS = 30 * 60_000

/** The agent's own label ("Q3.") when it gave one, else a bullet: the plugin's internal ids mean nothing to the person. */
export const askMark = (ask: NowDoingAsk) => (ask.label ? `${ask.label}.` : '•')

/** Open asks oldest first: by when they opened, then by id. */
export const oldestFirst = (asks: readonly NowDoingAsk[]) => [...asks].sort((a, b) => a.askedAt - b.askedAt || Number(a.id.slice(1)) - Number(b.id.slice(1)))

/** Up to `room` open asks, oldest first, its age at the right; when not all fit, the last counts the newer ones left out. */
function askRows(v: View, room: number): Row[] {
  const all = oldestFirst(v.openAsks)
  const shown = all.slice(0, Math.max(0, room))
  return shown.map((ask, i) => {
    const parts: Part[] = [{ text: '▌ ', color: 'warning' }, { text: `${askMark(ask)} ${ask.text}`, bold: true }]
    if (i === shown.length - 1 && all.length > shown.length) parts.push({ text: ` (+${all.length - shown.length} newer)`, dim: true })
    const age = v.now - ask.askedAt
    return { key: `ask-${i}`, parts, ...(age >= ASK_AGE_SHOWN_MS ? { tail: [{ text: `  ${duration(age)}`, dim: true }] } : {}) }
  })
}

// ── Progress ────────────────────────────────────────────────────────────────

const LABEL_WIDTH = 6

const labelled = (key: string, label: string, parts: Part[]): Row => ({ key, parts: [{ text: `  ${label.padEnd(LABEL_WIDTH)}`, dim: true }, ...parts] })

const runningShells = (v: View) => v.workers.filter(w => w.kind === 'shell' && w.finishedAt === undefined && isSpendCommand(w.command ?? ''))

function spendRow(v: View): Row | undefined {
  const said = v.brief?.spend
  const jobs = runningShells(v).map(w => `${clip(w.description, 40)} ${duration(v.now - w.startedAt)}`)
  const items = [...(said ? [said] : []), ...jobs]
  return items.length ? labelled('spend', 'spend', [{ text: '⚡ ', color: 'warning' }, { text: items.join(' · ') }]) : undefined
}

const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}.%$]+/gu) ?? [])

/** Two findings say the same when their word sets overlap by a Jaccard index of at least this. */
const SAME_FINDING = 0.6

function jaccard(a: Set<string>, b: Set<string>): number {
  let both = 0
  for (const w of a) if (b.has(w)) both++
  const either = a.size + b.size - both
  return either === 0 ? 1 : both / either
}

/** Newest first, a finding left out when a newer one says the same. */
export function distinctFindings(found: readonly NowDoingFound[]): NowDoingFound[] {
  const kept: { f: NowDoingFound; w: Set<string> }[] = []
  for (const f of [...found].reverse()) {
    const w = words(f.text)
    if (!kept.some(k => jaccard(k.w, w) >= SAME_FINDING)) kept.push({ f, w })
  }
  return kept.map(k => k.f)
}

function foundRow(v: View): Row | undefined {
  const found = distinctFindings((v.brief?.found ?? []).filter(f => v.inputAt === null || f.t > v.inputAt))
  return found.length ? labelled('found', 'found', [{ text: found.map(f => f.text).join(' · ') }]) : undefined
}

function nextRow(v: View): Row | undefined {
  const next = v.brief?.next ?? []
  return next.length ? labelled('next', 'next', [{ text: next.join(' → ') }]) : undefined
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
  ])
}

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
  const labelWidth = Math.min(12, Math.max(0, ...shown.map(s => s.worker.label.length)))
  const rows: Row[] = shown.map(({ worker, depth }, i) => {
    const isLast = i === shown.length - 1 && hidden.length === 0
    const left = `  ${'  '.repeat(depth)}${isLast ? '└' : '├'} ${clip(worker.label, labelWidth).padEnd(labelWidth)}  `
    const said = v.agentNow[worker.id] ?? worker.description
    return { key: `w-${worker.id}`, parts: [{ text: left, dim: true }, { text: said }], tail: statusParts(worker, v.now) }
  })
  if (hidden.length > 0) {
    const done = hidden.filter(h => h.worker.finishedAt !== undefined).length
    rows.push({ key: 'more', parts: [{ text: `  └ +${hidden.length} more (${done} done)`, dim: true }] })
  }
  return rows
}

/** One glyph per worker, for the collapsed header. */
const glyphParts = (v: View): Part[] =>
  treeOrder(v.workers).map(({ worker }) =>
    worker.finishedAt === undefined
      ? { text: '●', color: 'claude' as const }
      : { text: OUTCOME_MARK[worker.outcome ?? 'unknown'], color: MARK_COLOR[worker.outcome ?? 'unknown'] },
  )

// ── The band ────────────────────────────────────────────────────────────────

/** The header, then the non-empty blocks in order (asks, progress, workers); `isSpaced` puts a blank row above, between and below. */
export type Band = { header: Header; blocks: Row[][]; isSpaced: boolean }

/** Rows a band takes: the header, its blocks, and with spacing a blank above, below and between each two. */
const rowsOf = (blocks: Row[][], isSpaced: boolean) => {
  const full = blocks.filter(b => b.length > 0)
  return 1 + full.reduce((n, b) => n + b.length, 0) + (isSpaced ? full.length + 2 : 0)
}

/**
 * The band for a view `width` cells wide with `maxRows` rows. Asks give way
 * only to the header. When rows are short the workers go first, then
 * the spacing, then progress (plan, next, found, spend). Collapsed while the
 * person has just sent something, it is the header and every ask that fits.
 */
export function bandRows(v: View, width: number, maxRows: number): Band {
  if (!v.isExpanded) {
    const asks = askRows(v, maxRows - 1)
    const isSpaced = rowsOf([asks], true) <= maxRows
    return { header: header(v, width, glyphParts(v)), blocks: [asks].filter(b => b.length), isSpaced }
  }
  const asks = askRows(v, maxRows - 1)
  const progress = [spendRow(v), foundRow(v), nextRow(v), planRow(v)].filter((r): r is Row => r !== undefined)
  // Spacing is tried only with every progress row: a blank row never takes the place of a line of content.
  for (let kept = progress.length; kept >= 0; kept--) {
    for (const isSpaced of kept === progress.length ? [true, false] : [false]) {
      const shown = progress.slice(0, kept)
      // The tree's room: what is left once it is counted as a block of its own (one more spacer).
      const left = maxRows - rowsOf([asks, shown], isSpaced) - (isSpaced ? 1 : 0)
      const tree = treeRows(v, left)
      const blocks = [asks, shown, tree].filter(b => b.length)
      // Spacing is worth its rows only while it separates something: never blanks in place of every row there is.
      const isHollow = isSpaced && blocks.length === 0 && progress.length + v.workers.length > 0
      if (!isHollow && rowsOf(blocks, isSpaced) <= maxRows) return { header: header(v, width, []), blocks, isSpaced }
    }
  }
  return { header: header(v, width, []), blocks: [asks].filter(b => b.length), isSpaced: false }
}
