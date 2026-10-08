/** What the session is doing for the person, as the model judges it. */
export type BriefState = 'waiting' | 'working' | 'stuck' | 'done'

/** What the title edge shows: the model's state, or `errored` when the last turn died on an error. */
export type ShownState = BriefState | 'errored'

/** A result or finding, stamped with the time its window opened. */
export type NowDoingFound = { t: number; text: string }

/** The briefing a C2/C3 call leaves: state, spend and next replaced each time; found appended. */
export type NowDoingBrief = {
  state: BriefState
  found: NowDoingFound[]
  spend: string | null
  next: string[]
  updatedAt: number
  /** The `seq` of the main turn when its transcript was read: a brief read since a turn event judges it. */
  turnSeq: number | null
}

/**
 * Something the agent asked the person and nobody has answered: opened when a
 * brief quotes the asking sentence, closed only when a quoted later message
 * structurally answers or settles it.
 */
export type NowDoingAsk = {
  id: string
  text: string
  /** The assistant's own sentence, verbatim. */
  quote: string
  /** The agent's own label for it, when it numbered its asks: "Q3", "2", "(b)", "decision 2". */
  label: string | null
  askedAt: number
}

/**
 * What the open asks remember beyond the list itself, so a check holds across ticks:
 * the prompts the person composed (only these can answer an ask), the bare
 * approvals already spent (one closes one ask, ever), and the asks closed
 * (one is not re-opened from the message it was closed after).
 */
export type NowDoingAskMemory = {
  /** Normalized text of each prompt the person composed or sent from a bridge, newest last. */
  personPrompts: string[]
  /** Keys of bare approvals that already closed an ask. */
  usedApprovals: string[]
  /** Closed asks: the normalized asking sentence and the mark of the row that closed it (its position, as cursors mark one). */
  tombstones: { quote: string; closedAt: NowDoingMark }[]
}

/** Progress over the session's task list: completed of total, and the task in progress (else the next pending). */
export type NowDoingPlan = { done: number; total: number; current: string | null }

/** The main loop's last turn: running, or how it ended; `seq` counts its starts and ends. */
export type NowDoingTurn = { seq: number; isRunning: boolean; at: number; isAsking: boolean; isErrored: boolean }

/** An agent or background shell in the tree; `finishedAt` and `outcome` set once it ended. */
export type NowDoingWorker = {
  id: string
  kind: 'agent' | 'shell'
  label: string
  description: string
  /** A shell's command line. */
  command?: string
  parentId?: string
  startedAt: number
  /** When its transcript last gained or changed a row (an agent) or it started (a shell). */
  activeAt: number
  /** The fingerprint of its transcript's newest row at the last look. */
  seen?: string
  finishedAt?: number
  /** `unknown`: it vanished from the agent list without saying how it ended. */
  outcome?: 'ok' | 'failed' | 'unknown'
}

/** A row of a conversation: how many rows led up to it, and its fingerprint. */
export type NowDoingMark = { length: number; key: string }

/** `cut`: where the next delta starts (before any tool still running); `seen`: the last row summarized. */
export type NowDoingCursor = { cut: NowDoingMark | null; seen: NowDoingMark | null }

export type NowDoingCursors = {
  main: NowDoingCursor | null
  agents: Record<string, NowDoingCursor>
  /** When a tick first saw rows the last brief had not: the time its findings are stamped with. */
  windowStartAt: number | null
}

export type NowDoingErrorKind =
  | 'config'
  | 'usage-limit'
  | 'transient'
  | 'bad-json'

export type NowDoingError = { kind: NowDoingErrorKind; reason: string; since: number }

export type NowDoingSync =
  | { status: 'composing'; at: number }
  | { status: 'ready'; at: number; text: string }
  | { status: 'failed'; at: number; reason: string }

declare module 'claude-code' {
  interface PluginState {
    'now-doing': {
      mission: string | null
      brief: NowDoingBrief | null
      openAsks: NowDoingAsk[]
      /** The number the next opened ask's id takes. */
      askSeq: number
      askMemory: NowDoingAskMemory
      turn: NowDoingTurn | null
      stateSince: { state: ShownState; at: number } | null
      plan: NowDoingPlan | null
      workers: NowDoingWorker[]
      agentNow: Record<string, string>
      cursors: NowDoingCursors
      lastInputAt: number | null
      error: NowDoingError | null
      sync: NowDoingSync | null
      isHidden: boolean
      tick: number
    }
  }
}
