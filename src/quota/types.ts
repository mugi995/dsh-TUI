export type {
  QuotaCredits,
  QuotaError,
  QuotaProvider,
  QuotaProviderId,
  QuotaSnapshot,
  QuotaWindow,
} from '../adapter/ports/quota.js'

/** Credentials resolved from env / the providers' own CLI auth files. */
export interface QuotaKeys {
  readonly ollama?: string
  readonly opencodeGo?: string
  readonly commandCode?: string
  readonly openrouter?: string
  /** Optional OpenRouter management key for the account `/credits` read. */
  readonly openrouterManagement?: string
}
