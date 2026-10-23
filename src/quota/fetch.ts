import { QUOTA_OFFICIAL_BASE, quotaBaseURL, quotaEnabled, type QuotaSettings } from './config.js'
import type {
  QuotaCredits,
  QuotaError,
  QuotaKeys,
  QuotaProvider,
  QuotaProviderId,
  QuotaSnapshot,
  QuotaWindow,
} from './types.js'

const TIMEOUT_MS = 10_000

/** Join a configured API root with the provider's fixed relative path. */
const joinURL = (baseURL: string, path: string): string =>
  `${baseURL.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`

export class QuotaFetchError extends Error {
  constructor(
    readonly code: QuotaError['code'],
    readonly status?: number,
  ) {
    super(code)
    this.name = 'QuotaFetchError'
  }
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

const number = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

const isoFrom = (value: unknown): string | undefined => {
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined
  }
  const epoch = number(value)
  return epoch === undefined ? undefined : new Date(epoch).toISOString()
}

const clampPercent = (value: number): number => Math.min(100, Math.max(0, value))

async function getJson(url: string, token: string, fetchImpl: typeof fetch): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: controller.signal,
    })
    if (response.status === 401 || response.status === 403) throw new QuotaFetchError('unauthorized', response.status)
    if (response.status === 404) throw new QuotaFetchError('no-api', response.status)
    if (!response.ok) throw new QuotaFetchError('http', response.status)
    try {
      return await response.json()
    } catch {
      throw new QuotaFetchError('invalid')
    }
  } catch (error) {
    if (error instanceof QuotaFetchError) throw error
    if (error instanceof Error && error.name === 'AbortError') throw new QuotaFetchError('network')
    throw new QuotaFetchError('network')
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Ollama Cloud: the balance endpoint is the authoritative credit reading.
 * `included` is the plan's monthly allowance (with its reset period) and
 * `purchased` is the top-up balance. Usage percent is derived from the
 * allowance; providers that only return one of the two still render.
 */
export async function fetchOllamaQuota(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  baseURL: string = QUOTA_OFFICIAL_BASE.ollama,
): Promise<QuotaProvider> {
  const body = record(await getJson(joinURL(baseURL, 'api/balance'), apiKey, fetchImpl))
  const included = record(body?.included)
  const purchased = record(body?.purchased)
  const balance = number(included?.balance_usd)
  const allowance = number(included?.allowance_usd)
  const period = record(included?.period)
  const purchasedBalance = number(purchased?.balance_usd)
  const credits: QuotaCredits = {
    ...(balance === undefined ? {} : { remaining: balance }),
    ...(allowance === undefined ? {} : { limit: allowance }),
    ...(purchasedBalance === undefined ? {} : { purchased: purchasedBalance }),
    currency: 'USD',
  }
  const windows: QuotaWindow[] = []
  if (balance !== undefined && allowance !== undefined && allowance > 0) {
    const resetAt = isoFrom(period?.until)
    windows.push({
      id: 'included',
      usedPercent: clampPercent(((allowance - balance) / allowance) * 100),
      ...(resetAt === undefined ? {} : { resetAt }),
    })
  }
  if (balance === undefined && purchasedBalance === undefined && windows.length === 0) {
    throw new QuotaFetchError('invalid')
  }
  return { id: 'ollama', label: 'Ollama Cloud', windows, credits }
}

/**
 * OpenCode Go: `usage.rolling` / `weekly` / `monthly` each carry a used
 * percent and an ISO reset. The endpoint deliberately exposes percentages
 * only; exact dollar usage stays in the Console.
 */
export async function fetchOpenCodeGoQuota(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  baseURL: string = QUOTA_OFFICIAL_BASE['opencode-go'],
): Promise<QuotaProvider> {
  const body = record(await getJson(joinURL(baseURL, 'zen/go/v1/usage'), apiKey, fetchImpl))
  const usage = record(body?.usage)
  const windows: QuotaWindow[] = []
  for (const [id, source] of [['five-hour', 'rolling'], ['weekly', 'weekly'], ['monthly', 'monthly']] as const) {
    const raw = record(usage?.[source])
    const percent = number(raw?.percent)
    if (raw === undefined || percent === undefined) continue
    const resetAt = isoFrom(raw.resetsAt)
    windows.push({ id, usedPercent: clampPercent(percent), ...(resetAt === undefined ? {} : { resetAt }) })
  }
  if (windows.length === 0) throw new QuotaFetchError('invalid')
  return { id: 'opencode-go', label: 'OpenCode Go', windows }
}

const COMMAND_CODE_PLANS: Record<string, string> = {
  'individual-go': 'Go',
  'individual-goat': 'GOAT',
  'individual-pro': 'Pro',
  'individual-provider': 'Provider',
  'individual-max-10x': 'Max 10x',
  'individual-max-20x': 'Max 20x',
  'individual-max': 'Max 10x',
  'individual-ultra': 'Max 20x',
  'teams-pro': 'Team Pro',
  'teams-enterprise': 'Enterprise',
}

const planName = (planId: string | undefined): string | undefined => {
  if (planId === undefined) return undefined
  const normalized = planId.toLowerCase().replace(/_/g, '-')
  return COMMAND_CODE_PLANS[normalized] ?? planId
}

/**
 * Command Code: the CLI's own alpha endpoints. Credits are the monthly
 * remaining buckets (`monthlyCredits` is a remaining amount, not a limit);
 * five-hour and weekly windows carry used/cap. The schema is not public, so
 * every field is optional and the view degrades to whatever came back.
 */
export async function fetchCommandCodeQuota(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  baseURL: string = QUOTA_OFFICIAL_BASE['command-code'],
): Promise<QuotaProvider> {
  const query = (orgId: string | undefined): string =>
    orgId === undefined ? '' : `?orgId=${encodeURIComponent(orgId)}`
  const whoami = record(await getJson(`${joinURL(baseURL, 'alpha/whoami')}?limits=1`, apiKey, fetchImpl).catch(() => undefined))
  const org = record(whoami?.org) ?? record(record(whoami?.data)?.org)
  const orgId = text(org?.id)
  const creditsBody = record(await getJson(`${joinURL(baseURL, 'alpha/billing/credits')}${query(orgId)}`, apiKey, fetchImpl))
  const subscription = record(
    await getJson(`${joinURL(baseURL, 'alpha/billing/subscriptions')}${query(orgId)}`, apiKey, fetchImpl).catch(() => undefined),
  )
  const creditsRoot = record(creditsBody?.data) ?? creditsBody
  const credits = record(creditsRoot?.credits) ?? creditsRoot
  const limits = record(creditsRoot?.windowLimits) ?? record(credits?.windowLimits)
  const subscriptionData = record(subscription?.data) ?? subscription
  const monthly = number(credits?.monthlyCredits)
  const purchased = number(credits?.purchasedCredits)
  const free = number(credits?.freeCredits)
  const remaining = [monthly, purchased, free].every(value => value === undefined)
    ? undefined
    : (monthly ?? 0) + (purchased ?? 0) + (free ?? 0)
  const creditView: QuotaCredits | undefined = remaining === undefined
    ? undefined
    : {
        remaining,
        ...(purchased === undefined ? {} : { purchased }),
        ...(free === undefined ? {} : { free }),
        currency: 'USD',
      }
  const windows: QuotaWindow[] = []
  for (const [id, source] of [['five-hour', 'fiveHour'], ['weekly', 'weekly']] as const) {
    const raw = record(limits?.[source])
    const used = number(raw?.used)
    const cap = number(raw?.cap)
    if (raw === undefined || used === undefined || cap === undefined || cap <= 0) continue
    const resetAt = isoFrom(raw.resetAt)
    windows.push({
      id,
      usedPercent: clampPercent((used / cap) * 100),
      ...(resetAt === undefined ? {} : { resetAt }),
    })
  }
  const resetAt = isoFrom(subscriptionData?.currentPeriodEnd)
  if (resetAt !== undefined) windows.push({ id: 'monthly', resetAt })
  if (creditView === undefined && windows.length === 0) throw new QuotaFetchError('invalid')
  const plan = planName(text(subscriptionData?.planId))
  return { id: 'command-code', label: 'Command Code', ...(plan === undefined ? {} : { plan }), windows, ...(creditView === undefined ? {} : { credits: creditView }) }
}

/** OpenRouter's `/key` response (normal key) and `/credits` (management key). */
export async function fetchOpenRouterQuota(
  apiKey: string,
  managementKey: string = apiKey,
  fetchImpl: typeof fetch = fetch,
  baseURL: string = QUOTA_OFFICIAL_BASE.openrouter,
): Promise<QuotaProvider> {
  const [keyResult, creditsResult] = await Promise.all([
    getJson(joinURL(baseURL, 'key'), apiKey, fetchImpl).then(body => ({ body }), (error: unknown) => ({ error })),
    getJson(joinURL(baseURL, 'credits'), managementKey, fetchImpl).then(body => ({ body }), (error: unknown) => ({ error })),
  ])
  const keyError = 'error' in keyResult ? keyResult.error : undefined
  const creditsError = 'error' in creditsResult ? creditsResult.error : undefined
  if (keyError !== undefined && creditsError !== undefined) {
    throw keyError instanceof QuotaFetchError ? keyError : new QuotaFetchError('network')
  }
  const keyBody = 'body' in keyResult ? record(keyResult.body) : undefined
  const keyData = record(keyBody?.data) ?? keyBody
  const creditsBody = 'body' in creditsResult ? record(creditsResult.body) : undefined
  const creditsData = record(creditsBody?.data) ?? creditsBody

  // Account balance (`/credits`, management key): total purchased − used.
  const totalCredits = number(creditsData?.total_credits)
  const totalUsage = number(creditsData?.total_usage)
  // Per-key cap (`/key`): limit/limit_remaining.
  const keyLimit = number(keyData?.limit)
  const keyRemaining = number(keyData?.limit_remaining)
  let credits: QuotaCredits | undefined
  if (totalCredits !== undefined && totalUsage !== undefined) {
    credits = { remaining: totalCredits - totalUsage, limit: totalCredits, currency: 'USD' }
  } else if (keyLimit !== undefined && keyRemaining !== undefined) {
    credits = { remaining: keyRemaining, limit: keyLimit, currency: 'USD' }
  }

  // The effective budget is the cap that blocks first; fall back to the
  // smallest remaining budget when the server did not name one.
  const budgets = Array.isArray(keyData?.budgets)
    ? keyData.budgets.map(record).filter((budget): budget is Record<string, unknown> => budget !== undefined)
    : []
  const budget = record(keyData?.effective_budget) ?? budgets.reduce<Record<string, unknown> | undefined>((best, candidate) => {
    if (best === undefined) return candidate
    const remaining = number(candidate.remaining_usd)
    const bestRemaining = number(best.remaining_usd)
    return remaining !== undefined && bestRemaining !== undefined && remaining < bestRemaining ? candidate : best
  }, undefined)
  const budgetLimit = number(budget?.limit_usd)
  const budgetSpend = number(budget?.spend_usd)
  const windows: QuotaWindow[] = []
  if (budgetLimit !== undefined && budgetLimit > 0 && budgetSpend !== undefined) {
    const interval = text(budget?.reset_interval)
    const id = interval === 'daily' ? 'budget-daily'
      : interval === 'weekly' ? 'budget-weekly'
        : interval === 'monthly' ? 'budget-monthly'
          : 'budget'
    const resetAt = isoFrom(budget?.resets_at)
    windows.push({
      id,
      usedPercent: clampPercent((budgetSpend / budgetLimit) * 100),
      ...(resetAt === undefined ? {} : { resetAt }),
    })
  } else if (keyLimit !== undefined && keyLimit > 0 && keyRemaining !== undefined) {
    windows.push({ id: 'key', usedPercent: clampPercent(((keyLimit - keyRemaining) / keyLimit) * 100) })
  }
  if (credits === undefined && windows.length === 0) {
    throw keyError instanceof QuotaFetchError ? keyError : new QuotaFetchError('invalid')
  }
  return { id: 'openrouter', label: 'OpenRouter', credits, windows }
}

const errorProvider = (id: QuotaProviderId, label: string, error: unknown): QuotaProvider => {
  const failure = error instanceof QuotaFetchError ? error : new QuotaFetchError('network')
  return {
    id,
    label,
    windows: [],
    error: { code: failure.code, ...(failure.status === undefined ? {} : { status: failure.status }) },
  }
}

/**
 * Fetch every provider whose key is present, in a fixed display order.
 * One provider's failure never hides the others: it becomes an entry with
 * an `error` and no data.
 */
export async function fetchQuotaSnapshot(
  keys: QuotaKeys,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
  settings: QuotaSettings = { providers: {} },
): Promise<QuotaSnapshot> {
  const tasks: Promise<QuotaProvider>[] = []
  if (keys.ollama !== undefined && keys.ollama !== '' && quotaEnabled(settings, 'ollama')) {
    tasks.push(fetchOllamaQuota(keys.ollama, fetchImpl, quotaBaseURL(settings, 'ollama')).catch(error => errorProvider('ollama', 'Ollama Cloud', error)))
  }
  if (keys.opencodeGo !== undefined && keys.opencodeGo !== '' && quotaEnabled(settings, 'opencode-go')) {
    tasks.push(fetchOpenCodeGoQuota(keys.opencodeGo, fetchImpl, quotaBaseURL(settings, 'opencode-go')).catch(error => errorProvider('opencode-go', 'OpenCode Go', error)))
  }
  if (keys.commandCode !== undefined && keys.commandCode !== '' && quotaEnabled(settings, 'command-code')) {
    tasks.push(fetchCommandCodeQuota(keys.commandCode, fetchImpl, quotaBaseURL(settings, 'command-code')).catch(error => errorProvider('command-code', 'Command Code', error)))
  }
  const openrouterKey = keys.openrouter ?? keys.openrouterManagement
  if (openrouterKey !== undefined && openrouterKey !== '' && quotaEnabled(settings, 'openrouter')) {
    tasks.push(fetchOpenRouterQuota(
      openrouterKey,
      keys.openrouterManagement ?? openrouterKey,
      fetchImpl,
      quotaBaseURL(settings, 'openrouter'),
    ).catch(error => errorProvider('openrouter', 'OpenRouter', error)))
  }
  const providers = await Promise.all(tasks)
  return { providers, fetchedAt: now() }
}
