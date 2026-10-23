import type { QuotaProvider, QuotaSnapshot } from './types.js'

const WINDOW_LABELS: Record<string, string> = {
  'five-hour': '5h',
  weekly: '1w',
  monthly: '1m',
  included: '1m',
  key: 'key',
  budget: 'cap',
  'budget-daily': '1d',
  'budget-weekly': '1w',
  'budget-monthly': '1m',
}

const PROVIDER_LABELS: Record<string, string> = {
  ollama: 'ollama',
  'opencode-go': 'opencode go',
  'command-code': 'command code',
  openrouter: 'openrouter',
}

/**
 * A 10-cell usage bar in the requested `[##########]0%` form. The bracket
 * and fullwidth-percent look is intentional; the percentage is rounded to a
 * whole number because the footer is a glance surface.
 */
export function quotaBar(usedPercent: number, width = 10): string {
  const percent = Math.min(100, Math.max(0, Math.round(usedPercent)))
  const filled = Math.round((percent / 100) * width)
  return `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}]${percent}%`
}

const money = (value: number, currency: string): string => {
  const amount = Number.isInteger(value) ? value.toFixed(0) : value.toFixed(2)
  return currency === 'USD' ? `$${amount}` : `${amount} ${currency}`
}

const creditText = (provider: QuotaProvider): string => {
  const credits = provider.credits
  if (credits === undefined) return ''
  const currency = credits.currency ?? 'USD'
  if (credits.remaining !== undefined && credits.limit !== undefined) {
    // Ollama's included balance excludes the purchased bucket; append it so
    // the footer still shows every credit amount the account holds.
    const purchased = credits.purchased !== undefined && credits.purchased > 0
      ? `+${money(credits.purchased, currency)}`
      : ''
    return `${money(credits.remaining, currency)}/${money(credits.limit, currency)}${purchased}`
  }
  const amount = credits.remaining ?? credits.purchased ?? credits.limit
  return amount === undefined ? '' : money(amount, currency)
}

const providerLabel = (provider: QuotaProvider): string =>
  PROVIDER_LABELS[provider.id] ?? provider.label.toLowerCase()

/**
 * The always-on quota rows in the right column of the ctx/cache readout.
 * Credit balances stay
 * numeric; every reported window becomes a `[##########]0%` bar. Providers
 * with no usable data (no key, fetch error) simply contribute no row, and
 * window ids the footer does not know are skipped rather than guessed.
 */
export function quotaFooterLines(snapshot: QuotaSnapshot): string[] {
  const rows: { label: string; body: string }[] = []
  for (const provider of snapshot.providers) {
    if (provider.error !== undefined) continue
    const credit = creditText(provider)
    const windows = provider.windows.flatMap(window => {
      if (window.usedPercent === undefined) return []
      const label = WINDOW_LABELS[window.id]
      return label === undefined ? [] : [`${label} ${quotaBar(window.usedPercent)}`]
    })
    const body = [credit, ...windows].filter(part => part !== '').join('  ')
    if (body === '') continue
    rows.push({ label: providerLabel(provider), body })
  }
  if (rows.length === 0) return []
  const width = Math.max(...rows.map(row => row.label.length))
  return rows.map(row => `${row.label.padEnd(width)}  ${row.body}`)
}
