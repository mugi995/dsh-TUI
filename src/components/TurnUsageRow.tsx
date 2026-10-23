import React from 'react'
import { Text } from '../ui.js'
import { t } from '../i18n.js'
import { formatDuration, formatTokens } from '../terminal-utils/format.js'
import type { TurnUsageSummary } from '../adapter/ports/channel-view.js'

/**
 * The turn ledger as display segments: tokens in/out, the cache split (only
 * when the backend reported cache tokens — an unreported cache is absent,
 * not zero), duration, the model when asked for and noted, retries, and a
 * marker on an interrupted or failed turn whose ledger is partial. Shared by
 * the transcript row and the /tokens and /status reports so the three read
 * the same.
 */
export function turnUsageParts(usage: TurnUsageSummary, options: { readonly model?: boolean } = {}): string[] {
  const parts: string[] = [
    `↑${formatTokens(usage.input)}`,
    `↓${formatTokens(usage.output)}`,
  ]
  if (usage.cacheKnown && usage.cacheRead + usage.cacheWrite > 0) {
    const cacheParts: string[] = []
    if (usage.cacheRead > 0) cacheParts.push(t('usage-cache-read', { n: formatTokens(usage.cacheRead) }))
    if (usage.cacheWrite > 0) cacheParts.push(t('usage-cache-write', { n: formatTokens(usage.cacheWrite) }))
    parts.push(t('usage-cache-segment', { parts: cacheParts.join('/') }))
  }
  parts.push(formatDuration(usage.durationMs))
  if (options.model === true && usage.noteModel === true && usage.model !== undefined) parts.push(usage.model)
  if (usage.retries > 0) parts.push(t('usage-retry-segment', { n: usage.retries }))
  if (usage.outcome === 'interrupted') parts.push(t('usage-turn-outcome-interrupted'))
  else if (usage.outcome === 'error') parts.push(t('usage-turn-outcome-error'))
  return parts
}

/** One decimal, `.0` dropped: `42 tok/s`, `42.5 tok/s`. */
function formatTps(tps: number): string {
  const rounded = Math.round(tps * 10) / 10
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} tok/s`
}

/**
 * The always-on answer summary that closes a streaming turn: the model (with
 * its reasoning effort), the whole turn's wall-clock span, and the decode
 * speed. Unlike the ledger below it never hides the model — it is the one
 * line a reader uses to tell what answered, at which effort, how long it
 * took, and how fast it decoded.
 */
export function turnSummaryParts(usage: TurnUsageSummary, fallbackModel: string): string[] {
  const model = usage.model ?? fallbackModel
  const route = [model, usage.effort].filter(part => part !== undefined && part !== '').join(' / ')
  return [
    ...(route === '' ? [] : [route]),
    formatDuration(usage.durationMs),
    usage.decodeTps === undefined ? '— tok/s' : formatTps(usage.decodeTps),
  ]
}

export function TurnSummaryRow({ usage, model }: {
  usage: TurnUsageSummary
  /** Session model, used when the turn did not report one. */
  model: string
}): React.ReactNode {
  return (
    <Text color="subtle" wrap="truncate">{turnSummaryParts(usage, model).join(' · ')}</Text>
  )
}

/**
 * The quiet right-aligned ledger (settings `dsh-tui.turnUsageRow`, opt-in).
 * It hugs the right margin one notch dimmer than the thinking timer, names
 * the model only when it changed since the previous turn (`noteModel`,
 * decided at projection time), and appends the turn's decode speed when the
 * backend streamed one. Formatting happens at render time so a language
 * switch relabels history; the payload itself is immutable, which is what the
 * per-row memo compares.
 */
export function TurnUsageRow({ usage }: { usage: TurnUsageSummary }): React.ReactNode {
  const parts = turnUsageParts(usage, { model: true })
  if (usage.decodeTps !== undefined) parts.push(formatTps(usage.decodeTps))
  return (
    <Text color="subtle" wrap="truncate">{parts.join(' · ')}</Text>
  )
}
