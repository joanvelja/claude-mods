// The model side of now-doing, as pure functions: `$` never crosses an import,
// so register.tsx makes the call and asks this file what its result means.
import type { ModelCompleteRequest, ModelCompleteResult, ModelEffort } from 'claude-code'

import type { NowDoingErrorKind } from '../types'

// The full id: the `haiku` alias resolves to whatever the build maps it to.
export const MODEL = 'claude-haiku-5-5'
// Briefs are a few lines of JSON; the rest is headroom for the model's thinking at `medium`.
// The sync is a page of Markdown at `medium`, so it gets twice the room and time.
const SIZES = { brief: { maxTokens: 4096, timeoutMs: 30_000 }, sync: { maxTokens: 8192, timeoutMs: 60_000 } } as const

export type CallError = { kind: NowDoingErrorKind; reason: string }
export type CallResult = { ok: true; text: string } | { ok: false; error: CallError }

// Every section is budgeted, so a request stays near 60k characters at most;
// past this cap a budget is broken, and the request is refused rather than sent
// across the 100k-token price tier (a character is at most one token).
export const MAX_REQUEST_CHARS = 90_000

export function request(system: string, prompt: string, effort: ModelEffort, size: keyof typeof SIZES = 'brief'): ModelCompleteRequest {
  const chars = system.length + prompt.length
  if (chars > MAX_REQUEST_CHARS) throw new Error(`request of ${chars} characters is over the ${MAX_REQUEST_CHARS} cap: a section budget is broken`)
  return { model: MODEL, system, prompt, effort, ...SIZES[size] }
}

/** A completion's result as text or a typed failure: the kind decides pacing, the reason goes in the band. */
export function outcome(r: ModelCompleteResult): CallResult {
  if (r.isAnswered) return { ok: true, text: r.text }
  if (r.reason === 'empty-reply') return { ok: false, error: { kind: 'transient', reason: 'empty reply' } }
  if (r.reason === 'aborted') return { ok: false, error: { kind: 'transient', reason: 'cut short (timeout or reload)' } }
  const reason = `${r.error} (HTTP ${r.status ?? 'none'})`
  if (r.error === 'rate_limit') return { ok: false, error: { kind: 'usage-limit', reason } }
  // max_output_tokens: the reply outgrew our cap on this input; the next input may fit.
  if (r.error === 'overloaded' || r.error === 'server_error' || r.error === 'unknown' || r.error === 'max_output_tokens') {
    return { ok: false, error: { kind: 'transient', reason } }
  }
  return { ok: false, error: { kind: 'config', reason } }
}
