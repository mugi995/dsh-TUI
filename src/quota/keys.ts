import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { QuotaKeys } from './types.js'

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return undefined
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

/**
 * Resolve the three providers' API keys without storing anything:
 * environment first, then the CLIs' own auth files.
 *
 * - OpenCode Go: `OPENCODE_GO_API_KEY` / `OPENCODE_API_KEY`, then OpenCode's
 *   `auth.json` (API-key login) and `go-keys.json` (multi-plan file).
 * - Command Code: `COMMANDCODE_API_KEY` / `COMMAND_CODE_API_KEY` / `CMD_API_KEY`,
 *   then `~/.commandcode/auth.json` written by its CLI.
 * - Ollama Cloud: `OLLAMA_API_KEY` only (its CLI does not persist a key).
 */
export function resolveQuotaKeys(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): QuotaKeys {
  const dataHome = text(env.XDG_DATA_HOME) ?? join(home, '.local', 'share')
  const opencodeAuth = record(readJson(join(dataHome, 'opencode', 'auth.json')))
  const opencodeLoginKey = text(record(opencodeAuth?.['opencode-go'])?.key)
    ?? text(record(opencodeAuth?.opencode)?.key)
  const goKeys = record(readJson(join(home, '.config', 'opencode', 'go-keys.json')))
  const plans = Array.isArray(goKeys?.plans) ? goKeys.plans : []
  const activeIndex = (number(goKeys?.active) ?? 1) - 1
  const activePlan = record(plans[activeIndex])

  const commandAuth = record(readJson(join(home, '.commandcode', 'auth.json')))

  return {
    ollama: text(env.OLLAMA_API_KEY),
    opencodeGo: text(env.OPENCODE_GO_API_KEY)
      ?? text(env.OPENCODE_API_KEY)
      ?? opencodeLoginKey
      ?? text(activePlan?.key),
    commandCode: text(env.COMMANDCODE_API_KEY)
      ?? text(env.COMMAND_CODE_API_KEY)
      ?? text(env.CMD_API_KEY)
      ?? text(commandAuth?.apiKey),
    openrouter: text(env.OPENROUTER_API_KEY),
    openrouterManagement: text(env.OPENROUTER_MANAGEMENT_KEY),
  }
}
