/** Parsed `/quota` subcommand (kept pure so the dispatch is testable). */
export type QuotaCommand =
  | { readonly kind: 'report' }
  | { readonly kind: 'status' }
  | { readonly kind: 'help' }
  | { readonly kind: 'setup'; readonly provider?: string; readonly action?: string }
  | { readonly kind: 'reset'; readonly provider?: string }
  | { readonly kind: 'unknown'; readonly name: string }

/** Split `/quota`'s raw input. URLs stay one token; no quoting is needed. */
export function parseQuotaCommand(rawInput: string): QuotaCommand {
  const parts = rawInput.trim().split(/\s+/).filter(Boolean)
  const [sub, provider, action] = parts
  if (sub === undefined) return { kind: 'report' }
  if (sub === 'status') return { kind: 'status' }
  if (sub === 'help' || sub === '?') return { kind: 'help' }
  if (sub === 'setup') {
    return {
      kind: 'setup',
      ...(provider === undefined ? {} : { provider }),
      ...(action === undefined ? {} : { action }),
    }
  }
  if (sub === 'reset') {
    return { kind: 'reset', ...(provider === undefined ? {} : { provider }) }
  }
  return { kind: 'unknown', name: sub }
}
