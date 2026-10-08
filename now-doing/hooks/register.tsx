import { atom, read, update } from 'claude-code'
import type { AgentStatus, EngineInterface, Register, SessionMessage } from 'claude-code'

import type { NowDoingAsk, NowDoingAskMemory, NowDoingCursor, NowDoingSync, NowDoingWorker } from '../types'
import { askMark, bandRows, HEADER_BG, oldestFirst } from './band'
import type { Part, View } from './band'
import {
  applyAsks,
  emptyAskMemory,
  normalizeQuote,
  briefRequest,
  clip,
  cursorOf,
  duration,
  endsWithAsk,
  hasNew,
  lastRowKey,
  missionRequest,
  nextMission,
  parseBrief,
  parseMission,
  planOf,
  shownState,
  sliceAfter,
  stripInjected,
  syncRequest,
  tasks,
} from './digest'
import type { ModelAsk, RunningAgent, ShellJob } from './digest'
import { MODEL, outcome, request } from './model'
import type { CallError, CallResult } from './model'

const mission = atom({ plugin: 'now-doing', key: 'mission' } as const, null)
const brief = atom({ plugin: 'now-doing', key: 'brief' } as const, null)
const openAsks = atom({ plugin: 'now-doing', key: 'openAsks' } as const, [])
const askSeq = atom({ plugin: 'now-doing', key: 'askSeq' } as const, 1)
const askMemory = atom({ plugin: 'now-doing', key: 'askMemory' } as const, { personPrompts: [], usedApprovals: [], tombstones: [] })
const turn = atom({ plugin: 'now-doing', key: 'turn' } as const, null)
const stateSince = atom({ plugin: 'now-doing', key: 'stateSince' } as const, null)
const plan = atom({ plugin: 'now-doing', key: 'plan' } as const, null)
const workers = atom({ plugin: 'now-doing', key: 'workers' } as const, [])
const agentNow = atom({ plugin: 'now-doing', key: 'agentNow' } as const, {})
const cursors = atom({ plugin: 'now-doing', key: 'cursors' } as const, { main: null, agents: {}, windowStartAt: null })
const lastInputAt = atom({ plugin: 'now-doing', key: 'lastInputAt' } as const, null)
const error = atom({ plugin: 'now-doing', key: 'error' } as const, null)
const sync = atom({ plugin: 'now-doing', key: 'sync' } as const, null)
const isHidden = atom({ plugin: 'now-doing', key: 'isHidden' } as const, false)
const tick = atom({ plugin: 'now-doing', key: 'tick' } as const, 0)

const SYNC_PANE = 'now-doing-sync'
const TICK_MS = 5_000
const MIN_GAP_MS = 45_000
const MAX_GAP_MS = 300_000
const IDLE_MS = 120_000
const FINISHED_SHOWN_MS = 60_000
const URGENT_BRIEF_AGE_MS = 30_000
const USAGE_PAUSE_MS = 300_000
const FOUND_CAP = 30
const PERSON_PROMPTS_CAP = 200

const ENDED: ReadonlySet<AgentStatus> = new Set(['completed', 'failed', 'killed'])

const NOTIFICATION = /<task-notification>([\s\S]*?)<\/task-notification>/g

const isExpanded = (now: number, inputAt: number | null) => inputAt === null || now - inputAt >= IDLE_MS

// ── Runtime ─────────────────────────────────────────────────────────────────
// Correctness lives in $.state (cursors survive a hot reload); these are
// pacing and in-flight flags, which a reload may safely forget.
let isUrgent = false
let lastRunAt = 0
let gapMs = MIN_GAP_MS
let pausedUntil = 0
let isStopped = false
let isTicking = false
let isAnchoring = false
let isAnchorPending = false
let isSyncing = false
let wasExpanded = false
let missionChain: Promise<void> = Promise.resolve()
// Model calls running now, of any session: /clear does not cut them short.
let inFlight = 0
// Two counters: `epoch` changes with the session (/clear), so every result
// from before it is dropped; `anchorGeneration` lets a C3 supersede a C2 in
// flight without also discarding a mission update that is still valid.
let epoch = 0
let anchorGeneration = 0
// A brief failed while the current window was open: its findings may be from after the input.
let isWindowFailed = false

/** Records a failure of a call made in session `run`; one from a session since cleared changes nothing. */
async function failed($: EngineInterface, err: CallError, run: number): Promise<void> {
  if (run !== epoch) return
  const now = await $.clock.now()
  await update($, error, prev => ({ ...err, since: prev?.since ?? now }))
  if (err.kind === 'usage-limit') pausedUntil = now + USAGE_PAUSE_MS
  if (err.kind === 'transient' || err.kind === 'bad-json') gapMs = Math.min(gapMs * 2, MAX_GAP_MS)
  if (err.kind === 'config') isStopped = true
}

/** Runs `work`; an unexpected throw stops the briefs of the session it started in and says why in the band. */
async function guarded($: EngineInterface, what: string, work: () => Promise<void>): Promise<void> {
  const run = epoch
  try {
    await work()
  } catch (err) {
    $.ui.log(`now-doing: ${what} failed: ${String(err)}`, { to: 'debug' })
    await failed($, { kind: 'config', reason: `${what}: ${String(err)}` }, run)
  }
}

async function mayCall($: EngineInterface): Promise<boolean> {
  return !isStopped && !(await read($, isHidden)) && (await $.clock.now()) >= pausedUntil
}

// ── Model I/O ───────────────────────────────────────────────────────────────

async function complete($: EngineInterface, call: ModelAsk, size: 'brief' | 'sync'): Promise<CallResult> {
  inFlight += 1
  try {
    return outcome(await $.model.complete(request(call.system, call.prompt, call.effort, size)))
  } finally {
    inFlight -= 1
  }
}

/** The model's reply text, or undefined once the failure is logged and recorded; a refused request rejects. */
async function ask($: EngineInterface, call: ModelAsk, run: number): Promise<string | undefined> {
  const result = await complete($, call, 'brief')
  if (result.ok) return result.text
  $.ui.log(`now-doing: ${result.error.kind}: ${result.error.reason}`, { to: 'debug' })
  await failed($, result.error, run)
  return undefined
}

const badJson = ($: EngineInterface, what: string, run: number) =>
  failed($, { kind: 'bad-json', reason: `${what} reply was not the expected JSON` }, run)

// ── The title's state ───────────────────────────────────────────────────────

/** Restamps the state's start when the state the title shows has changed. */
async function trackState($: EngineInterface): Promise<void> {
  const isAnyRunning = (await read($, workers)).some(w => w.finishedAt === undefined)
  const state = shownState(await read($, turn), await read($, brief), isAnyRunning, (await read($, openAsks)).length)
  if (state === null || (await read($, stateSince))?.state === state) return
  const at = await $.clock.now()
  await update($, stateSince, () => ({ state, at }))
}

// ── The calls ───────────────────────────────────────────────────────────────

// C1: the mission, kept or replaced on each prompt the person composed. Its
// success never clears the brief's error: only a brief that landed says briefs work.
async function refineMission($: EngineInterface, prompt: string): Promise<void> {
  const run = epoch
  if (!(await mayCall($))) return
  const text = await ask($, missionRequest(await read($, mission), prompt), run)
  if (text === undefined || run !== epoch) return
  const reply = parseMission(text)
  if (!reply) return badJson($, 'mission', run)
  await update($, mission, prev => nextMission(prev, reply))
}

type Gathered = {
  main: SessionMessage[]
  mainDelta: SessionMessage[]
  running: RunningAgent[]
  next: { main: NowDoingCursor; agents: Record<string, NowDoingCursor> }
  isNew: boolean
  turnSeq: number | null
}

/** The main thread and each agent still running or finished with rows not yet briefed, cut at their cursors. */
async function gather($: EngineInterface): Promise<Gathered> {
  const at = await read($, cursors)
  const turnSeq = (await read($, turn))?.seq ?? null
  const now = await $.clock.now()
  const main = await $.session.messages()
  const running: RunningAgent[] = []
  const agentCursors: Record<string, NowDoingCursor> = {}
  let isNew = hasNew(main, at.main)
  for (const worker of (await read($, workers)).filter(w => w.kind === 'agent')) {
    const isFinished = worker.finishedAt !== undefined
    const found = await $.session.messages({ agentId: worker.id })
    if (!Array.isArray(found)) {
      $.ui.log(`now-doing: cannot read agent ${worker.id}: ${found.deny}`, { to: 'debug' })
      if (!isFinished) running.push({ ...worker, isFinished, delta: null })
      continue
    }
    const isAgentNew = hasNew(found, at.agents[worker.id])
    if (isFinished && !isAgentNew) continue
    agentCursors[worker.id] = cursorOf(found)
    isNew ||= isAgentNew
    const quietMs = worker.seen === undefined ? undefined : now - worker.activeAt
    running.push({ ...worker, isFinished, delta: sliceAfter(found, at.agents[worker.id]), quietMs })
  }
  return { main, mainDelta: sliceAfter(main, at.main), running, next: { main: cursorOf(main), agents: agentCursors }, isNew, turnSeq }
}

async function shellJobs($: EngineInterface): Promise<ShellJob[]> {
  return (await read($, workers))
    .filter(w => w.kind === 'shell' && w.finishedAt === undefined)
    .map(w => ({ description: w.description, command: w.command ?? '', startedAt: w.startedAt }))
}

async function briefCall($: EngineInterface, mode: 'tick' | 'anchor', g: Gathered): Promise<ModelAsk> {
  return briefRequest(mode, {
    mission: await read($, mission),
    main: g.main,
    mainDelta: g.mainDelta,
    agents: g.running,
    shells: await shellJobs($),
    previous: await read($, brief),
    openAsks: await read($, openAsks),
    now: await $.clock.now(),
    personPrompts: (await read($, askMemory)).personPrompts,
  })
}

/** Applies a C2/C3 reply: state, spend and next replaced, open asks changed only where a quote backs it, findings appended at the window's start, cursors advanced. */
async function commit($: EngineInterface, g: Gathered, text: string, what: string, run: number): Promise<void> {
  const reply = parseBrief(text, g.running.map(a => a.id))
  if (!reply) {
    isWindowFailed = true
    return badJson($, what, run)
  }
  const t = await $.clock.now()
  const inputAt = await read($, lastInputAt)
  let stamp = (await read($, cursors)).windowStartAt ?? t
  // A window held open across the input by failures holds work done after it:
  // one finding too many beats hiding everything the person missed.
  if (isWindowFailed && inputAt !== null && stamp <= inputAt) stamp = inputAt + 1
  isWindowFailed = false
  await update($, cursors, prev => ({ main: g.next.main, agents: { ...prev.agents, ...g.next.agents }, windowStartAt: null }))
  await update($, brief, prev => {
    // The model is told never to repeat a finding; one it repeats anyway keeps its first stamp.
    const known = new Set((prev?.found ?? []).map(f => f.text))
    const fresh = reply.found.filter(text => !known.has(text)).map(text => ({ t: stamp, text }))
    return {
      state: reply.state,
      found: [...(prev?.found ?? []), ...fresh].slice(-FOUND_CAP),
      spend: reply.spend,
      next: reply.next,
      updatedAt: t,
      turnSeq: g.turnSeq,
    }
  })
  for (const line of reply.dropped) $.ui.log(`now-doing: brief: ${line}`, { to: 'debug' })
  const asked = applyAsks(await read($, openAsks), reply, g.main, t, await read($, askSeq), await readAskMemory($))
  for (const line of asked.log) $.ui.log(`now-doing: open asks: ${line}`, { to: 'debug' })
  await update($, openAsks, () => asked.open)
  await update($, askSeq, () => asked.seq)
  // The person prompts may have grown while the call ran: keep the newest, take the rest from the reply.
  await update($, askMemory, prev => ({ ...asked.memory, personPrompts: prev.personPrompts }))
  await update($, agentNow, prev => ({ ...prev, ...reply.agents }))
  lastRunAt = t
  gapMs = MIN_GAP_MS
  await update($, error, () => null)
  await trackState($)
}

/**
 * The ask memory without closed-ask records stored before they were keyed by
 * the closing row's place (they carry its text, `closedBy`): those cannot be
 * placed, so they are reset, loudly, and the commit stores the memory without
 * them; the rest of it stays.
 */
async function readAskMemory($: EngineInterface): Promise<NowDoingAskMemory> {
  const memory = await read($, askMemory)
  const isOld = (t: NowDoingAskMemory['tombstones'][number]) => (t as { closedAt?: unknown }).closedAt === undefined
  const old = memory.tombstones.filter(isOld).length
  if (old === 0) return memory
  $.ui.log(`now-doing: ${old} old-format closed-ask records reset`, { to: 'debug' })
  return { ...memory, tombstones: memory.tombstones.filter(t => !isOld(t)) }
}

// C2: what changed since the last brief, main thread and running agents in one call.
async function summarize($: EngineInterface, now: number): Promise<void> {
  const run = epoch
  const g = await gather($)
  if (!g.isNew) {
    isUrgent = false
    return
  }
  if ((await read($, cursors)).windowStartAt === null) await update($, cursors, prev => ({ ...prev, windowStartAt: now }))
  if (!(await mayCall($)) || (!isUrgent && now - lastRunAt < gapMs)) return
  isUrgent = false
  lastRunAt = now
  const generation = anchorGeneration
  const text = await ask($, await briefCall($, 'tick', g), run)
  if (run !== epoch) return
  if (text === undefined) {
    isWindowFailed = true
    return
  }
  if (generation !== anchorGeneration) return
  await commit($, g, text, 'brief', run)
}

// C3: on the main turn's end, the brief rebuilt unseen over a wider window (drift reset);
// it appends findings like C2 and never rewrites recorded ones. Supersedes a C2 in flight.
async function reanchor($: EngineInterface): Promise<void> {
  if (isAnchoring) {
    isAnchorPending = true
    return
  }
  isAnchoring = true
  anchorGeneration += 1
  const run = epoch
  try {
    if (!(await mayCall($))) return
    const g = await gather($)
    if (g.main.length === 0) return
    const text = await ask($, await briefCall($, 'anchor', g), run)
    if (run !== epoch) return
    if (text === undefined) {
      isWindowFailed = true
      return
    }
    await commit($, g, text, 're-anchor', run)
  } finally {
    isAnchoring = false
    if (isAnchorPending) {
      isAnchorPending = false
      $.clock.after(0, () => guarded($, 're-anchor', () => reanchor($)))
    }
  }
}

// The sync: one medium call over the notes and a wider read, drawn in a pane.
// It has a slot of its own: its failure is the pane's to say, not the band's.
async function composeSync($: EngineInterface): Promise<void> {
  if (isSyncing) return
  isSyncing = true
  const run = epoch
  let result: CallResult
  try {
    const now = await $.clock.now()
    await update($, sync, () => ({ status: 'composing', at: now }))
    const all = await read($, workers)
    const agentRows: Record<string, SessionMessage[]> = {}
    for (const w of all.filter(w => w.kind === 'agent')) {
      const rows = await $.session.messages({ agentId: w.id })
      if (Array.isArray(rows)) agentRows[w.id] = rows
    }
    const call = syncRequest({
      now,
      inputAt: await read($, lastInputAt),
      mission: await read($, mission),
      brief: await read($, brief),
      main: await $.session.messages(),
      workers: all,
      agentNow: await read($, agentNow),
      agentRows,
      openAsks: await read($, openAsks),
      personPrompts: (await read($, askMemory)).personPrompts,
    })
    result = await complete($, call, 'sync')
  } catch (err) {
    $.ui.log(`now-doing: sync failed: ${String(err)}`, { to: 'debug' })
    result = { ok: false, error: { kind: 'config', reason: String(err) } }
  } finally {
    isSyncing = false
  }
  if (run !== epoch) return
  const at = await $.clock.now()
  const text = result.ok ? result.text.trim() : ''
  const shown: NowDoingSync = text ? { status: 'ready', at, text } : { status: 'failed', at, reason: result.ok ? 'empty reply' : result.error.reason }
  await update($, sync, () => shown)
}

// ── Workers: agents and background shells ───────────────────────────────────

const AGENT_OUTCOME: Partial<Record<AgentStatus, 'ok' | 'failed'>> = { completed: 'ok', failed: 'failed', killed: 'failed' }

/** One pass over the tree: finished rows leave after FINISHED_SHOWN_MS, agents follow the list, each running agent's last activity is noted. */
async function trackWorkers($: EngineInterface, now: number): Promise<void> {
  const listed = new Map((await $.agent.list()).map(a => [a.id, a]))
  const seen = new Map<string, string>()
  for (const w of await read($, workers)) {
    if (w.kind !== 'agent' || w.finishedAt !== undefined) continue
    const rows = await $.session.messages({ agentId: w.id })
    if (Array.isArray(rows)) seen.set(w.id, lastRowKey(rows))
  }
  let hasFinished = false
  const tracked = await update($, workers, prev => {
    hasFinished = false
    const kept: NowDoingWorker[] = []
    for (const w of prev) {
      if (w.finishedAt !== undefined) {
        if (now - w.finishedAt < FINISHED_SHOWN_MS) kept.push(w)
        continue
      }
      const info = w.kind === 'agent' ? listed.get(w.id) : undefined
      const key = seen.get(w.id)
      const looked = key === undefined || key === w.seen ? w : { ...w, seen: key, activeAt: w.seen === undefined ? w.activeAt : now }
      if (w.kind === 'agent' && (!info || ENDED.has(info.status))) {
        hasFinished = true
        kept.push({ ...looked, finishedAt: now, outcome: info ? AGENT_OUTCOME[info.status] : 'unknown' })
      } else kept.push(looked)
    }
    for (const a of listed.values()) {
      if (ENDED.has(a.status) || prev.some(w => w.id === a.id)) continue
      kept.push({ id: a.id, kind: 'agent', label: a.type, description: a.description, parentId: a.parentId, startedAt: now, activeAt: now })
    }
    return kept
  })
  if (hasFinished) isUrgent = true
  const live = new Set(tracked.map(w => w.id))
  const isGone = (id: string) => !live.has(id)
  if (Object.keys(await read($, agentNow)).some(isGone)) {
    await update($, agentNow, prev => Object.fromEntries(Object.entries(prev).filter(([id]) => live.has(id))))
  }
  if (Object.keys((await read($, cursors)).agents).some(isGone)) {
    await update($, cursors, prev => ({ ...prev, agents: Object.fromEntries(Object.entries(prev.agents).filter(([id]) => live.has(id))) }))
  }
}

async function finishShells($: EngineInterface, text: string): Promise<void> {
  const now = await $.clock.now()
  for (const [, body] of text.matchAll(NOTIFICATION)) {
    const toolUseId = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(body!)?.[1]
    const status = /<status>([^<]+)<\/status>/.exec(body!)?.[1]
    if (!toolUseId) continue
    if (!(await read($, workers)).some(w => w.id === toolUseId && w.finishedAt === undefined)) continue
    const outcome = status === 'completed' ? 'ok' : 'failed'
    await update($, workers, prev => prev.map(w => (w.id === toolUseId ? { ...w, finishedAt: now, outcome } : w)))
    isUrgent = true
  }
}

/** The plan row's numbers, written only when they change. */
async function trackPlan($: EngineInterface): Promise<void> {
  const fresh = planOf(tasks(await $.session.messages()))
  if (JSON.stringify(fresh) !== JSON.stringify(await read($, plan))) await update($, plan, () => fresh)
}

async function onTick($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  await update($, tick, () => now)
  await trackWorkers($, now)
  await trackPlan($)
  await trackState($)
  const expanded = isExpanded(now, await read($, lastInputAt))
  const current = await read($, brief)
  if (expanded && !wasExpanded && (!current || now - current.updatedAt > URGENT_BRIEF_AGE_MS)) isUrgent = true
  wasExpanded = expanded
  if (isTicking || isAnchoring) return
  isTicking = true
  try {
    await summarize($, now)
  } finally {
    isTicking = false
  }
}

/** A prompt the person composed and sent: the band collapses until it has been quiet IDLE_MS, and "found" starts over. */
async function noteInput($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  await update($, lastInputAt, () => now)
  // Close a window the person saw open promptly, so its findings stay out of the band's "found".
  if ((await read($, cursors)).windowStartAt !== null) isUrgent = true
}

function resetRuntime(): void {
  epoch += 1
  isWindowFailed = false
  isUrgent = false
  lastRunAt = 0
  gapMs = MIN_GAP_MS
  pausedUntil = 0
  isStopped = false
  wasExpanded = false
}

async function reset($: EngineInterface): Promise<void> {
  resetRuntime()
  await Promise.all([
    update($, mission, () => null),
    update($, brief, () => null),
    update($, openAsks, () => []),
    update($, askSeq, () => 1),
    update($, askMemory, () => emptyAskMemory()),
    update($, turn, () => null),
    update($, stateSince, () => null),
    update($, plan, () => null),
    update($, workers, () => []),
    update($, agentNow, () => ({})),
    update($, cursors, () => ({ main: null, agents: {}, windowStartAt: null })),
    update($, lastInputAt, () => null),
    update($, error, () => null),
    update($, sync, () => null),
  ])
}

/** The open asks as the sync pane shows them above the model's text: exact, not paraphrased by it. */
function asksMarkdown(open: readonly NowDoingAsk[], now: number): string {
  if (open.length === 0) return ''
  return ['**Open asks**', ...oldestFirst(open).map(a => `- ${askMark(a)} ${a.text} (${duration(now - a.askedAt)} ago)`)].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    resetRuntime()
    await $.command.register({
      name: 'now-doing',
      description: 'Refresh the now-doing band; `sync` opens a full briefing in a pane, `asks` lists every open ask, `status` reports the summarizer, `off` hides it, `on` shows it',
      argumentHint: '[sync|asks|status|off|on]',
    })
    $.clock.every(TICK_MS, () => guarded($, 'tick', () => onTick($)))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await reset($)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const kind = e.origin.kind
    if (kind === 'task-notification') await finishShells($, e.text)
    // What the person's prompt became once the hooks below ran: the text that enters the transcript.
    const entered = await next(e)
    if ((kind === 'composer' || kind === 'bridge') && entered.drop === undefined) {
      if (kind === 'composer') await noteInput($)
      const said = stripInjected(entered.text)
      if (said) {
        // Only prompts recorded here can answer an open ask: teammates and loops reach the transcript as user rows too.
        await update($, askMemory, prev => ({ ...prev, personPrompts: [...prev.personPrompts, normalizeQuote(said)].slice(-PERSON_PROMPTS_CAP) }))
        // The reply may answer the asks on screen: the next tick re-reads them.
        isUrgent = true
        $.clock.after(0, () => {
          missionChain = missionChain.then(() => guarded($, 'mission', () => refineMission($, said)))
        })
      }
    }
    return entered
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.run_in_background !== true || e.agentId !== undefined || ran.deny !== undefined || ran.isError) return ran
    try {
      const now = await $.clock.now()
      const shell: NowDoingWorker = {
        id: e.tool_use_id,
        kind: 'shell',
        label: 'bg',
        description: e.description ?? clip(e.command, 80),
        command: e.command,
        startedAt: now,
        activeAt: now,
      }
      await update($, workers, prev => [...prev, shell])
    } catch (err) {
      $.ui.log(`now-doing: could not track background shell ${e.tool_use_id}: ${String(err)}`, { to: 'debug' })
    }
    return ran
  })

  on('turn.start', async ($, e, next) => {
    const at = await $.clock.now()
    await update($, turn, prev => ({ seq: (prev?.seq ?? 0) + 1, isRunning: true, at, isAsking: false, isErrored: false }))
    await trackState($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const at = await $.clock.now()
      await update($, turn, prev => ({ seq: (prev?.seq ?? 0) + 1, isRunning: false, at, isAsking: endsWithAsk(e.answer), isErrored: e.reason === 'error' || e.reason === 'refusal' }))
      await trackState($)
      $.clock.after(0, () => guarded($, 're-anchor', () => reanchor($)))
    }
    return next(e)
  })

  // One hook for every slash command: a command the person types never reaches prompt.submit but is
  // input all the same; any command but ours passes on (a hook of ours on `next` would skip our own).
  on('command.run', async ($, e, next) => {
    if (e.origin?.kind === 'composer') {
      await noteInput($)
      isUrgent = true
    }
    if (e.command !== 'now-doing') return next(e)
    const arg = e.args.trim().toLowerCase()
    if (arg === 'sync') {
      const opened = await $.ui.open({ id: SYNC_PANE, title: 'now-doing sync' })
      $.clock.after(0, () => composeSync($))
      return { text: opened.isPlaced ? 'Composing a sync in the now-doing pane.' : `Composing a sync; its pane is not shown: ${opened.reason}` }
    }
    if (arg === 'asks') {
      const now = await $.clock.now()
      const open = oldestFirst(await read($, openAsks))
      if (open.length === 0) return { text: 'No open asks.' }
      return { text: open.map(a => `${askMark(a)} ${a.text} (${duration(now - a.askedAt)} ago)\n   "${a.quote}"`).join('\n') }
    }
    if (arg === 'off') {
      await update($, isHidden, () => true)
      return { text: 'Now-doing band hidden; no summaries run. `/now-doing on` brings it back.' }
    }
    if (arg === 'status') {
      const now = await $.clock.now()
      const err = await read($, error)
      const last = await read($, brief)
      return {
        text: [
          `model: ${MODEL}`,
          `last error: ${err ? `${err.kind}: ${err.reason} (${duration(now - err.since)} ago)` : 'none'}`,
          `last brief: ${last ? `${duration(now - last.updatedAt)} ago` : 'none yet'}`,
          `in flight: ${inFlight === 0 ? 'none' : `${inFlight} call${inFlight === 1 ? '' : 's'}`}`,
        ].join('\n'),
      }
    }
    if (arg !== '' && arg !== 'on') return { text: `Unknown argument "${arg}". Usage: /now-doing [sync|asks|status|off|on]` }
    await update($, isHidden, () => false)
    // The band reports the retry at once, not the failure it is retrying.
    await update($, error, () => null)
    isStopped = false
    pausedUntil = 0
    isUrgent = true
    return { text: 'Refreshing the now-doing band; it updates above the prompt within a few seconds.' }
  })

  on('ui.render', { component: 'Pane', requestId: SYNC_PANE }, async ($, e) => {
    const { Box, Text, Markdown } = $.ui.resolve(e)
    const now = await read($, tick)
    const s = await read($, sync)
    if (s === null) return <Text dimColor>No sync yet: /now-doing sync composes one.</Text>
    if (s.status === 'composing') return <Text dimColor>Composing the sync with {MODEL}… ({duration(now - s.at)} so far)</Text>
    if (s.status === 'failed') return <Text color="warning">⚠ sync failed: {s.reason}. /now-doing sync tries again.</Text>
    return (
      <Box flexDirection="column">
        <Text dimColor>composed {duration(Math.max(0, now - s.at))} ago · /now-doing sync refreshes</Text>
        <Markdown key="sync" text={[asksMarkdown(await read($, openAsks), now), s.text].filter(Boolean).join('\n\n')} />
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)
    await read($, tick)
    const now = await $.clock.now()
    const all = await read($, workers)
    const current = await read($, brief)
    const open = await read($, openAsks)
    const state = shownState(await read($, turn), current, all.some(w => w.finishedAt === undefined), open.length)
    const since = await read($, stateSince)
    const view: View = {
      now,
      isExpanded: isExpanded(now, await read($, lastInputAt)),
      mission: await read($, mission),
      brief: current,
      openAsks: open,
      state,
      stateAt: since !== null && since.state === state ? since.at : now,
      plan: await read($, plan),
      workers: all,
      agentNow: await read($, agentNow),
      inputAt: await read($, lastInputAt),
      error: await read($, error),
    }
    const width = e.props.bodyColumns
    if (e.props.maxRows < 1 || width < 24) return next(e)
    const { header, blocks, isSpaced } = bandRows(view, width, e.props.maxRows)
    if (blocks.length === 0 && state === null && header.right.length === 0) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const draw = (parts: Part[]) =>
      parts.map(p => (
        <Text bold={p.bold} dimColor={p.dim} color={p.color}>
          {p.text}
        </Text>
      ))
    const blank = <Text> </Text>
    // Ink measures every glyph: a row's body takes what its fixed tail leaves, the mission what the state leaves.
    return (
      <Box flexDirection="column">
        {isSpaced ? blank : null}
        <Box key="title" width={width} flexDirection="row" backgroundColor={HEADER_BG}>
          <Box key="title-left" flexShrink={0}>
            <Text>{draw(header.left)}</Text>
          </Box>
          <Box key="title-right" flexGrow={1} width={0} height={1} overflow="hidden">
            <Text wrap="truncate-end">{draw(header.right)}</Text>
          </Box>
        </Box>
        {blocks.map(rows => (
          <Box flexDirection="column">
            {isSpaced ? blank : null}
            {rows.map(row => (
              <Box key={row.key} width={width} flexDirection="row">
                <Box flexGrow={1} width={0} height={1} overflow="hidden">
                  <Text wrap="truncate-end">{draw(row.parts)}</Text>
                </Box>
                {row.tail ? (
                  <Box flexShrink={0}>
                    <Text>{draw(row.tail)}</Text>
                  </Box>
                ) : null}
              </Box>
            ))}
          </Box>
        ))}
        {isSpaced ? blank : null}
      </Box>
    )
  })
}
