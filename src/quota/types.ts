/**
 * Provider-neutral subscription quota view.
 *
 * Every backend/account reports a different subset: Ollama Cloud has money
 * balances, OpenCode Go only window percentages, Command Code credits plus
 * rolling windows. The renderer therefore consumes OPTIONAL fields and
 * prints only what a provider actually returned.
 */

export type QuotaProviderId = 'ollama' | 'opencode-go' | 'command-code' | 'openrouter'

/** One usage window (`five-hour`, `weekly`, `monthly`, `included`). */
export interface QuotaWindow {
  /** Stable id used to localize the label (`five-hour`, `weekly`, ...). */
  readonly id: string
  /** Percent of the window already used (0–100), when reported. */
  readonly usedPercent?: number
  /** Absolute amounts for windows that report money instead of a percent. */
  readonly used?: number
  readonly limit?: number
  /** ISO 8601 reset timestamp, when reported. */
  readonly resetAt?: string
}

/** Money balances a provider reports alongside/instead of windows. */
export interface QuotaCredits {
  readonly remaining?: number
  readonly limit?: number
  readonly purchased?: number
  readonly free?: number
  /** ISO 4217 code; defaults to USD at render time. */
  readonly currency?: string
}

export interface QuotaError {
  readonly code: 'unauthorized' | 'http' | 'network' | 'invalid' | 'no-api'
  readonly status?: number
}

export interface QuotaProvider {
  readonly id: QuotaProviderId
  /** Literal display name (product name, not localized). */
  readonly label: string
  /** Plan name, when the provider reports one. */
  readonly plan?: string
  readonly windows: readonly QuotaWindow[]
  readonly credits?: QuotaCredits
  readonly error?: QuotaError
}

export interface QuotaSnapshot {
  readonly providers: readonly QuotaProvider[]
  /** Epoch ms the snapshot finished fetching. */
  readonly fetchedAt: number
}

/** Credentials resolved from env / the providers' own CLI auth files. */
export interface QuotaKeys {
  readonly ollama?: string
  readonly opencodeGo?: string
  readonly commandCode?: string
  readonly openrouter?: string
  /** Optional OpenRouter management key for the account `/credits` read. */
  readonly openrouterManagement?: string
}
