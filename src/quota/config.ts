import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from '../utils/paths.js'
import type { QuotaProviderId } from './types.js'

export const QUOTA_PROVIDER_IDS = ['ollama', 'opencode-go', 'command-code', 'openrouter'] as const

/**
 * Where each account API lives when no override is configured. The fetchers
 * append their provider-specific paths to this base:
 *
 *   ollama        + /api/balance
 *   opencode-go   + /zen/go/v1/usage
 *   command-code  + /alpha/...
 *   openrouter    + /key, /credits   (the base is the API root, not the host)
 */
export const QUOTA_OFFICIAL_BASE: Record<QuotaProviderId, string> = {
  ollama: 'https://ollama.com',
  'opencode-go': 'https://opencode.ai',
  'command-code': 'https://api.commandcode.ai',
  openrouter: 'https://openrouter.ai/api/v1',
}

export interface QuotaProviderSetting {
  readonly enabled: boolean
  /** Optional API root override; paths are appended by the fetchers. */
  readonly baseURL?: string
}

export interface QuotaSettings {
  readonly providers: Partial<Record<QuotaProviderId, QuotaProviderSetting>>
}

export const QUOTA_SETTINGS_FILE = 'quota.json'

export const QUOTA_PROVIDER_LABELS: Record<QuotaProviderId, string> = {
  ollama: 'Ollama Cloud',
  'opencode-go': 'OpenCode Go',
  'command-code': 'Command Code',
  openrouter: 'OpenRouter',
}

/** Command-line aliases; `/quota setup go ...` is the shortest form. */
export const QUOTA_PROVIDER_ALIASES: Record<string, QuotaProviderId> = {
  ollama: 'ollama',
  'ollama-cloud': 'ollama',
  opencode: 'opencode-go',
  'opencode-go': 'opencode-go',
  go: 'opencode-go',
  commandcode: 'command-code',
  'command-code': 'command-code',
  command: 'command-code',
  cc: 'command-code',
  openrouter: 'openrouter',
  or: 'openrouter',
}

export const resolveQuotaProviderId = (value: string): QuotaProviderId | undefined =>
  QUOTA_PROVIDER_ALIASES[value.trim().toLowerCase()]

/** Credential refs the quota fetchers resolve, in priority order. */
export const QUOTA_KEY_REFS: Record<QuotaProviderId, readonly string[]> = {
  ollama: ['OLLAMA_API_KEY'],
  'opencode-go': ['OPENCODE_GO_API_KEY', 'OPENCODE_API_KEY'],
  'command-code': ['COMMANDCODE_API_KEY', 'COMMAND_CODE_API_KEY', 'CMD_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
}

export const QUOTA_MANAGEMENT_KEY_REFS: Partial<Record<QuotaProviderId, readonly string[]>> = {
  openrouter: ['OPENROUTER_MANAGEMENT_KEY'],
}

export const isQuotaProviderId = (value: string): value is QuotaProviderId =>
  (QUOTA_PROVIDER_IDS as readonly string[]).includes(value)

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

/**
 * Validate a quota API root. Only https is accepted; plain http is allowed
 * for loopback development (127.0.0.1 / localhost / ::1). Credentials are
 * sent to this base, so userinfo, query strings and fragments are rejected.
 * A path prefix is allowed because relays commonly mount the API below one.
 */
export function normalizeQuotaBaseURL(raw: string): string | undefined {
  const value = raw.trim()
  if (value === '') return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.username !== '' || url.password !== '') return undefined
  if (url.search !== '' || url.hash !== '') return undefined
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1'
  if (url.protocol === 'http:' && !loopback) return undefined
  const path = url.pathname.replace(/\/+$/, '')
  return `${url.origin}${path === '/' ? '' : path}`
}

const parseProvider = (value: unknown): QuotaProviderSetting | undefined => {
  const row = record(value)
  if (row === undefined) return undefined
  const enabled = row.enabled !== false
  const baseURL = typeof row.baseURL === 'string' ? normalizeQuotaBaseURL(row.baseURL) : undefined
  return { enabled, ...(baseURL === undefined ? {} : { baseURL }) }
}

/** Best-effort read; a missing/corrupt file means "all defaults". */
export function readQuotaSettings(dir: string = DATA_DIR): QuotaSettings {
  try {
    const parsed = record(JSON.parse(readFileSync(join(dir, QUOTA_SETTINGS_FILE), 'utf8')))
    const providers = record(parsed?.providers)
    if (providers === undefined) return { providers: {} }
    const out: Partial<Record<QuotaProviderId, QuotaProviderSetting>> = {}
    for (const id of QUOTA_PROVIDER_IDS) {
      const setting = parseProvider(providers[id])
      if (setting !== undefined) out[id] = setting
    }
    return { providers: out }
  } catch {
    return { providers: {} }
  }
}

/** Persist the non-secret quota settings (keys remain in the credentials store). */
export function writeQuotaSettings(settings: QuotaSettings, dir: string = DATA_DIR): void {
  mkdirSync(dir, { recursive: true })
  const providers: Record<string, QuotaProviderSetting> = {}
  for (const id of QUOTA_PROVIDER_IDS) {
    const setting = settings.providers[id]
    if (setting === undefined) continue
    providers[id] = {
      enabled: setting.enabled,
      ...(setting.baseURL === undefined ? {} : { baseURL: setting.baseURL }),
    }
  }
  writeFileSync(
    join(dir, QUOTA_SETTINGS_FILE),
    `${JSON.stringify({ version: 1, providers }, null, 2)}\n`,
    { mode: 0o600 },
  )
}

/** Effective base for one provider (custom override wins over the official root). */
export function quotaBaseURL(settings: QuotaSettings, id: QuotaProviderId): string {
  return settings.providers[id]?.baseURL ?? QUOTA_OFFICIAL_BASE[id]
}

/** Whether a provider is enabled (absent entry = enabled default). */
export function quotaEnabled(settings: QuotaSettings, id: QuotaProviderId): boolean {
  return settings.providers[id]?.enabled !== false
}
