import { formatDuration } from '../terminal-utils/format.js'
import { t } from '../i18n.js'
import type { QuotaCredits, QuotaError, QuotaProvider, QuotaSnapshot, QuotaWindow } from './types.js'

const WINDOW_KEYS = {
  'five-hour': 'quota-window-five-hour',
  weekly: 'quota-window-weekly',
  monthly: 'quota-window-monthly',
  included: 'quota-window-included',
  key: 'quota-window-key',
  budget: 'quota-window-budget',
  'budget-daily': 'quota-window-budget-daily',
  'budget-weekly': 'quota-window-budget-weekly',
  'budget-monthly': 'quota-window-budget-monthly',
} as const

const pad = (value: number): string => String(value).padStart(2, '0')

const money = (value: number, currency: string = 'USD'): string =>
  currency === 'USD' ? `$${value.toFixed(2)}` : `${value.toFixed(2)} ${currency}`

const percent = (value: number): string => {
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

const resetText = (iso: string, now: number): string | undefined => {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return undefined
  const remaining = at - now
  if (remaining <= 0) return t('quota-reset-now')
  if (remaining < 86_400_000) return t('quota-reset-in', { duration: formatDuration(remaining) })
  const date = new Date(at)
  return t('quota-reset-at', {
    date: `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`,
  })
}

const windowText = (window: QuotaWindow, now: number, currency: string): string => {
  const parts: string[] = []
  if (window.usedPercent !== undefined) {
    parts.push(t('quota-used-percent', { percent: percent(window.usedPercent) }))
  } else if (window.used !== undefined && window.limit !== undefined && window.limit > 0) {
    parts.push(t('quota-used-limit', { used: money(window.used, currency), limit: money(window.limit, currency) }))
  }
  if (window.resetAt !== undefined) {
    const reset = resetText(window.resetAt, now)
    if (reset !== undefined) parts.push(reset)
  }
  return parts.length === 0 ? t('quota-no-data') : parts.join(' · ')
}

const creditParts = (credits: QuotaCredits): string[] => {
  const currency = credits.currency ?? 'USD'
  const parts: string[] = []
  if (credits.remaining !== undefined) {
    parts.push(credits.limit === undefined
      ? t('quota-credit-remaining', { remaining: money(credits.remaining, currency) })
      : t('quota-credit-remaining-limit', {
          remaining: money(credits.remaining, currency),
          limit: money(credits.limit, currency),
        }))
  } else if (credits.limit !== undefined) {
    parts.push(t('quota-credit-limit', { limit: money(credits.limit, currency) }))
  }
  if (credits.purchased !== undefined) {
    parts.push(t('quota-credit-purchased', { amount: money(credits.purchased, currency) }))
  }
  if (credits.free !== undefined && credits.free > 0) {
    parts.push(t('quota-credit-free', { amount: money(credits.free, currency) }))
  }
  return parts
}

const errorText = (error: QuotaError): string => {
  switch (error.code) {
    case 'unauthorized': return t('quota-error-unauthorized')
    case 'http': return t('quota-error-http', { status: error.status ?? '?' })
    case 'network': return t('quota-error-network')
    case 'invalid': return t('quota-error-invalid')
    case 'no-api': return t('quota-error-no-api')
  }
}

const windowLabel = (id: string): string => {
  const key = WINDOW_KEYS[id as keyof typeof WINDOW_KEYS]
  return key === undefined ? id : t(key)
}

const providerLines = (provider: QuotaProvider, now: number): string[] => {
  const heading = provider.plan === undefined ? provider.label : `${provider.label} · ${provider.plan}`
  const lines = [heading]
  if (provider.error !== undefined) {
    lines.push(`  ${errorText(provider.error)}`)
    return lines
  }
  let reported = false
  if (provider.credits !== undefined) {
    const parts = creditParts(provider.credits)
    if (parts.length > 0) {
      lines.push(`  ${t('quota-credits-label')} ${parts.join(' · ')}`)
      reported = true
    }
  }
  const currency = provider.credits?.currency ?? 'USD'
  for (const window of provider.windows) {
    lines.push(`  ${windowLabel(window.id)} ${windowText(window, now, currency)}`)
    reported = true
  }
  if (!reported) lines.push(`  ${t('quota-no-data')}`)
  return lines
}

/**
 * Turn a snapshot into report lines, printing only what each provider
 * actually returned: balances, percent windows, reset times, or an error.
 * No placeholder rows are invented for fields the API did not send.
 */
export function formatQuotaReport(snapshot: QuotaSnapshot, now: number = Date.now()): string[] {
  if (snapshot.providers.length === 0) return [t('quota-none')]
  return snapshot.providers.flatMap(provider => providerLines(provider, now))
}
