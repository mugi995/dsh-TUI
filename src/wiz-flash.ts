/**
 * Built-in WiZ bulb flash on DSH turn completion.
 *
 * DSH publishes `session/event` records on the Cordis bus. A top-level turn
 * that ends with `reason.kind === 'completed'` triggers a short color fade on
 * a WiZ bulb, then restores the bulb's previous scene/color/temperature/
 * brightness. Subagent turns and non-completed endings never flash.
 *
 * Two transports:
 * - `udp`: the bulb's local JSON API on port 38899 (same LAN as the bulb).
 * - `http`: POST a flash request to a `wizctl serve` instance. This is the
 *   path for a laptop that reaches the always-on machine over Tailscale but
 *   cannot route to the bulb's LAN.
 *
 * The feature is opt-in. With no `~/.dsh-tui/wiz-flash.json` and no
 * `DSH_TUI_WIZ_FLASH=1`, `apply` does nothing. Visual settings can be shared
 * with wizctl's `.wizctl/flash.json` (`settingsPath`), and its device registry
 * (`credentialsPath`) supplies the bulb IP and the new-firmware signing key.
 *
 * @module @deepseek-harness-tui/dsh-tui/wiz-flash
 */
import { createHmac } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import { DATA_DIR, homeDir } from './utils/paths.js'

export const name = 'wiz-flash'

type JsonObject = Record<string, unknown>
type FlashMode = 'auto' | 'udp' | 'http'
type WhenOff = 'skip' | 'flash'
type Transport = 'udp' | 'http'

/** Row/file configuration accepted by the plugin. */
export interface WizFlashConfig {
  enabled?: boolean
  mode?: FlashMode
  url?: string
  settingsPath?: string
  credentialsPath?: string
  ip?: string
  target?: string
  key?: string
  port?: number
  timeoutMs?: number
  httpTimeoutMs?: number
  cooldownMs?: number
  lockPath?: string
  debug?: boolean
  requireLiveStart?: boolean
  turnEndFlash?: boolean
  approvalGlow?: boolean
  approvalColor?: string
  approvalBrightness?: number
  approvalWhenOff?: WhenOff
  approvalMaxMs?: number
  approvalStartDelayMs?: number
}

interface FlashSettings {
  enabled: boolean
  target: string
  color: string
  brightness: number
  fadeMs: number
  holdMs: number
  steps: number
  whenOff: WhenOff
  cooldownMs: number
}

interface ResolvedOptions {
  enabled: boolean
  mode: FlashMode
  url: string
  settingsPath: string
  credentialsPath: string
  ip: string
  target: string
  key: string
  port: number
  timeoutMs: number
  httpTimeoutMs: number
  cooldownMs: number
  lockPath: string
  debug: boolean
  requireLiveStart: boolean
  turnEndFlash: boolean
  approvalGlow: boolean
  approvalColor: string
  approvalBrightness: number
  approvalWhenOff: WhenOff
  approvalMaxMs: number
  approvalStartDelayMs: number
  settings: FlashSettings
}

interface PilotState {
  raw: JsonObject
  mac?: string
  on: boolean
  dimming?: number
  temp?: number
  r?: number
  g?: number
  b?: number
  sceneId: number
  speed?: number
}

interface Credentials {
  ip?: string
  mac?: string
  key?: string
}

interface DiscoveredBulb {
  ip: string
  mac: string
}

interface SessionLike {
  id?: string | number
  header?: { origin?: string; delegationDepth?: number }
}

interface SessionEventLike {
  type?: string
  data?: {
    reason?: string | { kind?: string }
    id?: string
    outcome?: string
  }
}

/** The Cordis surface this plugin uses (kept minimal for offline tests). */
export interface WizFlashContext {
  on(event: 'session/event', listener: (session: SessionLike | undefined, event: SessionEventLike | undefined) => void): () => void
  on(event: 'session/disposed', listener: (session: SessionLike | undefined) => void): () => void
  logger?: { debug?: (message: string) => void }
  /**
   * Cordis effect registration. The returned disposer restores a held
   * approval glow when the TUI unmounts; hosts without `effect` simply
   * skip that best-effort cleanup.
   */
  effect?(setup: () => () => void): void
}

const CONFIG_FILE = join(DATA_DIR, 'wiz-flash.json')
const DEFAULT_COLOR = '#2f6bff'
const DEFAULT_LOCK = join(DATA_DIR, 'wiz-flash.lock')
const LOCK_STALE_MS = 6_000

const DEFAULT_OPTIONS: Omit<ResolvedOptions, 'settings'> = {
  enabled: false,
  mode: 'auto',
  url: '',
  settingsPath: '',
  credentialsPath: '',
  ip: '',
  target: '',
  key: '',
  port: 38_899,
  timeoutMs: 1_200,
  httpTimeoutMs: 5_000,
  cooldownMs: 2_500,
  lockPath: DEFAULT_LOCK,
  debug: false,
  requireLiveStart: false,
  turnEndFlash: true,
  approvalGlow: true,
  approvalColor: DEFAULT_COLOR,
  approvalBrightness: 55,
  approvalWhenOff: 'flash',
  approvalMaxMs: 600_000,
  approvalStartDelayMs: 200,
}

const DEFAULT_SETTINGS: FlashSettings = {
  enabled: true,
  target: '',
  color: DEFAULT_COLOR,
  brightness: 55,
  fadeMs: 300,
  holdMs: 1_000,
  steps: 6,
  whenOff: 'skip',
  cooldownMs: DEFAULT_OPTIONS.cooldownMs,
}

const NAMED_COLORS: Record<string, string> = {
  red: '#ff0000',
  green: '#00ff00',
  blue: '#0000ff',
  white: '#ffffff',
  warm: '#ffc58f',
  orange: '#ff8c00',
  pink: '#ff69b4',
  purple: '#8a2be2',
  cyan: '#00ffff',
  yellow: '#ffff00',
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    if (['1', 'true', 'yes', 'on', 'enabled'].includes(text)) return true
    if (['0', 'false', 'no', 'off', 'disabled', ''].includes(text)) return false
  }
  return fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function expandHomePath(path: string): string {
  if (path === '~') return homeDir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homeDir(), path.slice(2))
  return path
}

function readJsonFile(path: string): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return isObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function normalizeMac(value: unknown): string {
  const cleaned = asString(value).toLowerCase().replaceAll(/[^0-9a-f]/gu, '')
  return cleaned.length === 12 ? cleaned : ''
}

function normalizeKey(value: unknown): string {
  const cleaned = asString(value).toLowerCase().replaceAll(/[^0-9a-f]/gu, '')
  return cleaned.length === 32 ? cleaned : ''
}

function isIpv4(value: string): boolean {
  const parts = value.split('.')
  return parts.length === 4 && parts.every(part => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
}

function normalizeColor(value: unknown, fallback: string): string {
  const text = asString(value).toLowerCase()
  if (text !== '') {
    const hex = NAMED_COLORS[text] ?? text
    if (/^#[0-9a-f]{3}$/u.test(hex)) {
      return `#${hex.slice(1).split('').map(ch => ch + ch).join('')}`
    }
    if (/^#[0-9a-f]{6}$/u.test(hex)) return hex
    if (/^[0-9a-f]{6}$/u.test(hex)) return `#${hex}`
  }
  return normalizeColor(fallback, DEFAULT_COLOR)
}

function normalizeSettings(source: JsonObject | undefined, base: FlashSettings): FlashSettings {
  const raw = source ?? {}
  const enabled = raw.enabled === undefined ? base.enabled : asBoolean(raw.enabled, base.enabled)
  const whenOffRaw = raw.when_off ?? raw.whenOff
  return {
    enabled,
    target: asString(raw.target) || base.target,
    color: normalizeColor(raw.color, base.color),
    brightness: clamp(Math.round(asNumber(raw.brightness, base.brightness)), 10, 100),
    fadeMs: clamp(Math.round(asNumber(raw.fade_ms ?? raw.fadeMs, base.fadeMs)), 0, 3_000),
    holdMs: clamp(Math.round(asNumber(raw.hold_ms ?? raw.holdMs, base.holdMs)), 0, 3_000),
    steps: clamp(Math.round(asNumber(raw.steps, base.steps)), 2, 20),
    whenOff: whenOffRaw === undefined ? base.whenOff : (asString(whenOffRaw) === 'flash' ? 'flash' : 'skip'),
    cooldownMs: clamp(Math.round(asNumber(raw.cooldown_ms ?? raw.cooldownMs, base.cooldownMs)), 0, 60_000),
  }
}

function resolveOptions(config: WizFlashConfig): ResolvedOptions {
  const bridge = readJsonFile(CONFIG_FILE)
  const row = isObject(config) ? config : {}
  const source: JsonObject = { ...DEFAULT_OPTIONS, ...row, ...(bridge ?? {}) }
  const env = process.env

  if (env.DSH_TUI_WIZ_FLASH !== undefined) source.enabled = asBoolean(env.DSH_TUI_WIZ_FLASH, false)
  if (env.DSH_TUI_WIZ_FLASH_MODE !== undefined) source.mode = env.DSH_TUI_WIZ_FLASH_MODE
  if (env.DSH_TUI_WIZ_FLASH_URL !== undefined) source.url = env.DSH_TUI_WIZ_FLASH_URL
  if (env.DSH_TUI_WIZ_FLASH_SETTINGS !== undefined) source.settingsPath = env.DSH_TUI_WIZ_FLASH_SETTINGS
  if (env.DSH_TUI_WIZ_FLASH_CREDENTIALS !== undefined) source.credentialsPath = env.DSH_TUI_WIZ_FLASH_CREDENTIALS
  if (env.DSH_TUI_WIZ_FLASH_IP !== undefined) source.ip = env.DSH_TUI_WIZ_FLASH_IP
  if (env.DSH_TUI_WIZ_FLASH_TARGET !== undefined) source.target = env.DSH_TUI_WIZ_FLASH_TARGET
  if (env.DSH_TUI_WIZ_FLASH_KEY !== undefined) source.key = env.DSH_TUI_WIZ_FLASH_KEY
  if (env.DSH_TUI_WIZ_FLASH_PORT !== undefined) source.port = env.DSH_TUI_WIZ_FLASH_PORT
  if (env.DSH_TUI_WIZ_FLASH_TIMEOUT_MS !== undefined) source.timeoutMs = env.DSH_TUI_WIZ_FLASH_TIMEOUT_MS
  if (env.DSH_TUI_WIZ_FLASH_HTTP_TIMEOUT_MS !== undefined) source.httpTimeoutMs = env.DSH_TUI_WIZ_FLASH_HTTP_TIMEOUT_MS
  if (env.DSH_TUI_WIZ_FLASH_DEBUG !== undefined) source.debug = env.DSH_TUI_WIZ_FLASH_DEBUG
  if (env.DSH_TUI_WIZ_FLASH_TURN_END !== undefined) source.turnEndFlash = env.DSH_TUI_WIZ_FLASH_TURN_END
  if (env.DSH_TUI_WIZ_FLASH_APPROVAL !== undefined) source.approvalGlow = env.DSH_TUI_WIZ_FLASH_APPROVAL
  if (env.DSH_TUI_WIZ_FLASH_APPROVAL_COLOR !== undefined) source.approvalColor = env.DSH_TUI_WIZ_FLASH_APPROVAL_COLOR
  if (env.DSH_TUI_WIZ_FLASH_APPROVAL_BRIGHTNESS !== undefined) source.approvalBrightness = env.DSH_TUI_WIZ_FLASH_APPROVAL_BRIGHTNESS
  if (env.DSH_TUI_WIZ_FLASH_APPROVAL_WHEN_OFF !== undefined) source.approvalWhenOff = env.DSH_TUI_WIZ_FLASH_APPROVAL_WHEN_OFF
  if (env.DSH_TUI_WIZ_FLASH_APPROVAL_MAX_MS !== undefined) source.approvalMaxMs = env.DSH_TUI_WIZ_FLASH_APPROVAL_MAX_MS
  if (env.DSH_TUI_WIZ_FLASH_APPROVAL_DELAY_MS !== undefined) source.approvalStartDelayMs = env.DSH_TUI_WIZ_FLASH_APPROVAL_DELAY_MS

  const settingsPath = expandHomePath(asString(source.settingsPath))
  let credentialsPath = expandHomePath(asString(source.credentialsPath))
  if (credentialsPath === '' && settingsPath !== '') {
    const sibling = join(dirname(settingsPath), 'config.json')
    if (existsSync(sibling)) credentialsPath = sibling
  }

  const baseSettings = normalizeSettings(source, DEFAULT_SETTINGS)
  const settingsFile = settingsPath === '' ? undefined : readJsonFile(settingsPath)
  const settings = settingsFile === undefined ? baseSettings : normalizeSettings(settingsFile, baseSettings)
  const enabled = asBoolean(source.enabled, false) && settings.enabled
  const modeText = asString(source.mode).toLowerCase()
  const mode: FlashMode = modeText === 'udp' || modeText === 'http' ? modeText : 'auto'

  return {
    enabled,
    mode,
    url: asString(source.url),
    settingsPath,
    credentialsPath,
    ip: asString(source.ip),
    target: asString(source.target),
    key: normalizeKey(source.key),
    port: clamp(Math.round(asNumber(source.port, DEFAULT_OPTIONS.port)), 1, 65_535),
    timeoutMs: clamp(Math.round(asNumber(source.timeoutMs, DEFAULT_OPTIONS.timeoutMs)), 100, 10_000),
    httpTimeoutMs: clamp(Math.round(asNumber(source.httpTimeoutMs, DEFAULT_OPTIONS.httpTimeoutMs)), 500, 60_000),
    cooldownMs: settings.cooldownMs,
    lockPath: expandHomePath(asString(source.lockPath) || DEFAULT_OPTIONS.lockPath),
    debug: asBoolean(source.debug, false),
    requireLiveStart: asBoolean(source.requireLiveStart, false),
    turnEndFlash: asBoolean(source.turnEndFlash ?? source.turn_end_flash, true),
    approvalGlow: asBoolean(source.approvalGlow ?? source.approval_glow, true),
    approvalColor: normalizeColor(source.approvalColor ?? source.approval_color, settings.color),
    approvalBrightness: clamp(Math.round(asNumber(source.approvalBrightness ?? source.approval_brightness, settings.brightness)), 10, 100),
    approvalWhenOff: asString(source.approvalWhenOff ?? source.approval_when_off).toLowerCase() === 'skip' ? 'skip' : 'flash',
    approvalMaxMs: clamp(Math.round(asNumber(source.approvalMaxMs ?? source.approval_max_ms, 600_000)), 500, 3_600_000),
    approvalStartDelayMs: clamp(Math.round(asNumber(source.approvalStartDelayMs ?? source.approval_start_delay_ms, 200)), 0, 5_000),
    settings,
  }
}

function deviceEntries(value: unknown): Array<[string, JsonObject]> {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => (isObject(item) ? [[String(index), item] as [string, JsonObject]] : []))
  }
  if (isObject(value)) {
    return Object.entries(value).flatMap(([key, item]) => (isObject(item) ? [[key, item] as [string, JsonObject]] : []))
  }
  return []
}

function loadCredentials(options: ResolvedOptions, target: string): Credentials {
  const credentials: Credentials = {}
  if (options.ip !== '') credentials.ip = options.ip
  if (options.key !== '') credentials.key = options.key
  if (options.credentialsPath === '') return credentials

  const data = readJsonFile(options.credentialsPath)
  if (data === undefined) return credentials

  const targetMac = normalizeMac(target)
  const entries = deviceEntries(data.devices)
  let record: JsonObject | undefined
  if (targetMac !== '') {
    record = entries.find(([key, item]) => normalizeMac(item.mac) === targetMac || normalizeMac(key) === targetMac)?.[1]
  }
  if (record === undefined && target !== '') {
    const wanted = target.toLowerCase()
    record = entries.find(([, item]) => {
      return asString(item.alias).toLowerCase() === wanted
        || asString(item.name).toLowerCase() === wanted
        || asString(item.ip) === target
    })?.[1]
  }
  if (record === undefined && target === '' && entries.length === 1) {
    record = entries[0]?.[1]
  }
  if (record === undefined) return credentials

  if (credentials.ip === undefined) {
    const ip = asString(record.ip)
    if (ip !== '') credentials.ip = ip
  }

  const mac = normalizeMac(record.mac) || targetMac
  if (mac !== '') {
    credentials.mac = mac
    const keysByMac = isObject(data.keys_by_mac) ? data.keys_by_mac : undefined
    const direct = keysByMac === undefined ? undefined : keysByMac[mac] ?? keysByMac[asString(record.mac)]
    if (credentials.key === undefined && direct !== undefined) {
      const key = normalizeKey(direct)
      if (key !== '') credentials.key = key
    }

    const homes = isObject(data.homes) ? data.homes : undefined
    const homeId = asString(record.home_id ?? record.homeId)
    const home = homes === undefined || homeId === '' ? undefined : homes[homeId]
    if (credentials.key === undefined && isObject(home)) {
      const key = normalizeKey(home.udp_signing_key ?? home.udpSigningKey)
      if (key !== '') credentials.key = key
    }
  }

  if (credentials.key === undefined && data.default_key !== undefined) {
    const key = normalizeKey(data.default_key)
    if (key !== '') credentials.key = key
  }
  return credentials
}

function broadcastAddresses(): string[] {
  const addresses = new Set<string>(['255.255.255.255'])
  for (const list of Object.values(networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue
      const ip = info.address.split('.').map(Number)
      const mask = info.netmask.split('.').map(Number)
      if (ip.length !== 4 || mask.length !== 4) continue
      const broadcast = ip.map((part, index) => (part & mask[index]) | (~mask[index] & 255))
      addresses.add(broadcast.join('.'))
    }
  }
  return [...addresses]
}

function discoverBulb(target: string, port: number, timeoutMs: number): Promise<DiscoveredBulb> {
  if (isIpv4(target)) return Promise.resolve({ ip: target, mac: '' })
  const targetMac = normalizeMac(target)

  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4')
    const found = new Map<string, DiscoveredBulb>()
    let settled = false
    let timer: NodeJS.Timeout | undefined

    const finish = (error?: Error, value?: DiscoveredBulb): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      try {
        socket.close()
      } catch {
        // already closed
      }
      if (error !== undefined) reject(error)
      else if (value !== undefined) resolve(value)
    }

    const choose = (): void => {
      if (targetMac !== '') {
        const match = found.get(targetMac)
        finish(match === undefined ? new Error(`wiz-flash: bulb ${targetMac} did not answer discovery`) : undefined, match)
        return
      }
      const values = [...found.values()]
      if (values.length === 1) {
        finish(undefined, values[0])
        return
      }
      if (values.length === 0) {
        finish(new Error('wiz-flash: no WiZ bulb answered discovery'))
        return
      }
      finish(new Error(`wiz-flash: ${values.length} bulbs answered discovery; set "target" to a MAC`))
    }

    timer = setTimeout(choose, timeoutMs)
    socket.once('error', error => finish(error))
    socket.on('message', (data, remote) => {
      try {
        const parsed: unknown = JSON.parse(data.toString('utf8'))
        if (!isObject(parsed) || !isObject(parsed.result)) return
        const mac = normalizeMac(parsed.result.mac)
        if (mac === '') return
        found.set(mac, { ip: remote.address, mac })
        if (targetMac !== '' && mac === targetMac) finish(undefined, { ip: remote.address, mac })
      } catch {
        // ignore non-JSON packets
      }
    })

    socket.bind(() => {
      try {
        socket.setBroadcast(true)
      } catch {
        // the limited broadcast below still applies
      }
      const payload = Buffer.from(JSON.stringify({ method: 'getPilot', params: {} }), 'utf8')
      for (const address of broadcastAddresses()) {
        socket.send(payload, port, address, () => {
          // best effort; the timer decides
        })
      }
    })
  })
}

function signRequest(method: string, params: JsonObject, key: Buffer): JsonObject {
  const signedParams: JsonObject = { ...params, sigTs: Math.floor(Date.now() / 1_000) }
  const compact = JSON.stringify(signedParams)
  const hmac = createHmac('sha256', key).update(compact).digest('base64')
  return { method, env: 'pro', params: signedParams, hmac }
}

interface WizResponse {
  method?: string
  env?: string
  result?: JsonObject
  error?: { code?: number; message?: string }
}

class BulbLink {
  private requiresSignature = false

  constructor(
    private readonly ip: string,
    private readonly port: number,
    private readonly key: Buffer | undefined,
    private readonly timeoutMs: number,
  ) {}

  async getPilot(): Promise<PilotState> {
    const response = await this.request('getPilot', {})
    return parsePilot(response.result)
  }

  async setPilot(params: JsonObject): Promise<void> {
    await this.request('setPilot', params)
  }

  private async request(method: string, params: JsonObject): Promise<WizResponse> {
    const signed = this.requiresSignature && this.key !== undefined
    let response = await this.send(signed ? signRequest(method, params, this.key as Buffer) : { method, params })

    if (response.env === 'pro') this.requiresSignature = true
    if (response.error?.code === -32_602 && this.key !== undefined && !signed) {
      this.requiresSignature = true
      response = await this.send(signRequest(method, params, this.key))
      if (response.env === 'pro') this.requiresSignature = true
    }
    if (response.error?.code === -32_602 && this.key === undefined) {
      throw new Error('wiz-flash: this bulb requires a signing key (wizctl udp_signing_key)')
    }
    if (response.error !== undefined) {
      const code = response.error.code ?? '?'
      const message = response.error.message ?? 'rejected'
      throw new Error(`wiz-flash: WiZ ${method} failed (${code}): ${message}`)
    }
    return response
  }

  private send(payload: JsonObject): Promise<WizResponse> {
    return new Promise((resolve, reject) => {
      const socket = createSocket('udp4')
      let settled = false
      let timer: NodeJS.Timeout | undefined

      const finish = (error?: Error, value?: WizResponse): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        try {
          socket.close()
        } catch {
          // already closed
        }
        if (error !== undefined) reject(error)
        else if (value !== undefined) resolve(value)
      }

      timer = setTimeout(() => {
        finish(new Error(`wiz-flash: ${this.ip}:${this.port} timed out after ${this.timeoutMs}ms`))
      }, this.timeoutMs)
      socket.once('error', error => finish(error))
      socket.on('message', data => {
        try {
          const parsed: unknown = JSON.parse(data.toString('utf8'))
          finish(undefined, isObject(parsed) ? (parsed as WizResponse) : {})
        } catch {
          finish(new Error('wiz-flash: invalid JSON from the bulb'))
        }
      })
      socket.send(Buffer.from(JSON.stringify(payload), 'utf8'), this.port, this.ip, error => {
        if (error !== null) finish(error)
      })
    })
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function parsePilot(result: JsonObject | undefined): PilotState {
  const raw = result ?? {}
  const state = raw.state
  return {
    raw,
    mac: normalizeMac(raw.mac) || undefined,
    on: state === true || state === 1 || state === '1' || raw.is_on === true,
    dimming: numberOrUndefined(raw.dimming),
    temp: numberOrUndefined(raw.temp),
    r: numberOrUndefined(raw.r),
    g: numberOrUndefined(raw.g),
    b: numberOrUndefined(raw.b),
    sceneId: numberOrUndefined(raw.sceneId ?? raw.scene_id) ?? 0,
    speed: numberOrUndefined(raw.speed),
  }
}

function kelvinToRgb(kelvin: number): [number, number, number] {
  const k = clamp(kelvin, 1_000, 40_000) / 100
  const red = k <= 66 ? 255 : 329.698727446 * (k - 60) ** -0.1332047592
  const green = k <= 66 ? 99.4708025861 * Math.log(k) - 161.1195681661 : 288.1221695283 * (k - 60) ** -0.0755148492
  const blue = k >= 66 ? 255 : k <= 19 ? 0 : 138.5177312231 * Math.log(k - 10) - 305.0447927307
  return [
    Math.round(clamp(red, 0, 255)),
    Math.round(clamp(green, 0, 255)),
    Math.round(clamp(blue, 0, 255)),
  ]
}

function hexToRgb(color: string): [number, number, number] {
  const normalized = normalizeColor(color, DEFAULT_COLOR).slice(1)
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ]
}

function rgbToHex(rgb: readonly [number, number, number]): string {
  return `#${rgb.map(value => clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0')).join('')}`
}

function smoothstep(value: number): number {
  const t = clamp(value, 0, 1)
  return t * t * (3 - 2 * t)
}

function lerpRgb(start: readonly [number, number, number], end: readonly [number, number, number], t: number): [number, number, number] {
  return [
    Math.round(start[0] + (end[0] - start[0]) * t),
    Math.round(start[1] + (end[1] - start[1]) * t),
    Math.round(start[2] + (end[2] - start[2]) * t),
  ]
}

function endColor(state: PilotState): [number, number, number] {
  if (!state.on) return [0, 0, 0]
  if (state.r !== undefined || state.g !== undefined || state.b !== undefined) {
    return [state.r ?? 0, state.g ?? 0, state.b ?? 0]
  }
  if (state.temp !== undefined) return kelvinToRgb(state.temp)
  return [255, 255, 255]
}

function restoreParams(state: PilotState): JsonObject {
  const params: JsonObject = { state: state.on }
  if (state.on) {
    if (state.sceneId !== 0) {
      params.sceneId = state.sceneId
      if (state.speed !== undefined) params.speed = state.speed
    } else if (state.r !== undefined || state.g !== undefined || state.b !== undefined) {
      params.r = state.r ?? 0
      params.g = state.g ?? 0
      params.b = state.b ?? 0
    } else if (state.temp !== undefined) {
      params.temp = state.temp
    }
  } else if (state.temp !== undefined) {
    params.temp = state.temp
  }
  if (state.dimming !== undefined) params.dimming = state.dimming
  return params
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, Math.max(0, milliseconds))
  })
}

function acquireLock(path: string): number | null {
  try {
    mkdirSync(dirname(path), { recursive: true })
  } catch {
    return -1
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(path, 'wx', 0o600)
      try {
        writeSync(descriptor, String(process.pid))
      } catch {
        // the lock still holds
      }
      return descriptor
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') return -1
      try {
        if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(path)
          continue
        }
      } catch {
        continue
      }
      return null
    }
  }
  return null
}

function releaseLock(descriptor: number, path: string): void {
  if (descriptor < 0) return
  try {
    closeSync(descriptor)
  } catch {
    // already closed
  }
  try {
    unlinkSync(path)
  } catch {
    // already removed
  }
}

async function resolveBulb(options: ResolvedOptions, settings: FlashSettings): Promise<{ ip: string; key: Buffer | undefined }> {
  const target = settings.target || options.target
  const credentials = loadCredentials(options, target)
  let ip = options.ip || credentials.ip || ''
  if (ip === '' && isIpv4(target)) ip = target
  if (ip === '') {
    const discovered = await discoverBulb(target, options.port, options.timeoutMs)
    ip = discovered.ip
  }
  const keyHex = options.key || credentials.key || ''
  return { ip, key: keyHex === '' ? undefined : Buffer.from(keyHex, 'hex') }
}

async function flashUdp(options: ResolvedOptions, settings: FlashSettings): Promise<JsonObject> {
  const bulb = await resolveBulb(options, settings)
  const lock = acquireLock(options.lockPath)
  if (lock === null) return { flashed: false, reason: 'busy' }

  const link = new BulbLink(bulb.ip, options.port, bulb.key, options.timeoutMs)
  let state: PilotState | undefined
  let touched = false
  try {
    state = await link.getPilot()
    if (!state.on && settings.whenOff !== 'flash') {
      return { flashed: false, reason: 'off', target: bulb.ip, restored: state.raw }
    }

    const targetRgb = hexToRgb(settings.color)
    const startRgb = endColor(state)
    const startLevel = state.on ? state.dimming ?? 0 : 0
    const peak = clamp(Math.max(settings.brightness, startLevel), 10, 100)
    const endLevel = state.on ? state.dimming ?? 10 : 10
    const steps = Math.max(2, settings.steps)
    const stepSleep = Math.max(0, settings.fadeMs) / steps
    touched = true

    for (let index = 1; index <= steps; index += 1) {
      const t = smoothstep(index / steps)
      const rgb = lerpRgb(startRgb, targetRgb, t)
      const level = Math.round(startLevel + (peak - startLevel) * t)
      try {
        await link.setPilot({ state: true, r: rgb[0], g: rgb[1], b: rgb[2], dimming: Math.max(10, level) })
      } catch (error) {
        if (index === 1) throw error
      }
      await sleep(stepSleep)
    }

    await sleep(settings.holdMs)

    for (let index = 1; index <= steps; index += 1) {
      const t = smoothstep(index / steps)
      const rgb = lerpRgb(targetRgb, startRgb, t)
      const level = Math.round(peak + (endLevel - peak) * t)
      try {
        await link.setPilot({ state: true, r: rgb[0], g: rgb[1], b: rgb[2], dimming: Math.max(10, level) })
      } catch {
        // keep restoring; a dropped frame is not fatal
      }
      await sleep(stepSleep)
    }

    await link.setPilot(restoreParams(state))
    touched = false
    return { flashed: true, color: rgbToHex(targetRgb), target: bulb.ip, restored: restoreParams(state) }
  } finally {
    if (touched && state !== undefined) {
      try {
        await link.setPilot(restoreParams(state))
      } catch {
        // best effort: the bulb will fall back to its own settings
      }
    }
    releaseLock(lock, options.lockPath)
  }
}

async function flashHttp(options: ResolvedOptions, settings: FlashSettings): Promise<JsonObject> {
  if (options.url === '') throw new Error('wiz-flash: no bridge url configured')
  const payload = {
    settings: {
      target: settings.target || options.target,
      color: settings.color,
      brightness: settings.brightness,
      fade_ms: settings.fadeMs,
      hold_ms: settings.holdMs,
      steps: settings.steps,
      when_off: settings.whenOff,
    },
  }
  const response = await fetch(options.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(options.httpTimeoutMs),
  })
  const text = await response.text()
  let data: JsonObject = {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (isObject(parsed)) data = parsed
  } catch {
    // non-JSON error bodies are reported below
  }
  if (!response.ok) throw new Error(`wiz-flash: bridge HTTP ${response.status}: ${text.slice(0, 200)}`)
  if (data.ok === false) throw new Error(`wiz-flash: bridge rejected the flash: ${text.slice(0, 200)}`)
  return data
}

/** A bulb as reported by the wizctl HTTP bridge. */
interface BridgeDevice {
  mac: string
  alias: string
  name: string
  ip: string
  online: boolean
  state?: JsonObject
}

/** A held approval glow; restore() puts the captured state back. */
interface ApprovalGlow {
  restore: () => Promise<void>
}

function bridgeEndpoint(url: string, endpoint: 'devices' | 'pilot'): string {
  const parsed = new URL(url)
  if (/\/api\/flash\/test\/?$/u.test(parsed.pathname)) {
    parsed.pathname = parsed.pathname.replace(/\/api\/flash\/test\/?$/u, `/api/${endpoint}`)
  } else {
    parsed.pathname = `/api/${endpoint}`
  }
  parsed.search = ''
  return parsed.toString()
}

async function fetchBridgeDevices(options: ResolvedOptions): Promise<BridgeDevice[]> {
  const response = await fetch(bridgeEndpoint(options.url, 'devices'), {
    signal: AbortSignal.timeout(options.httpTimeoutMs),
  })
  const text = await response.text()
  let data: JsonObject = {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (isObject(parsed)) data = parsed
  } catch {
    // reported below
  }
  if (!response.ok) throw new Error(`wiz-flash: bridge devices HTTP ${response.status}: ${text.slice(0, 200)}`)
  const raw = Array.isArray(data.devices) ? data.devices : []
  return raw.flatMap(item => {
    if (!isObject(item)) return []
    return [{
      mac: normalizeMac(item.mac),
      alias: asString(item.alias),
      name: asString(item.name),
      ip: asString(item.ip),
      online: item.online === true,
      state: isObject(item.state) ? item.state : undefined,
    }]
  })
}

function findBridgeDevice(devices: BridgeDevice[], target: string): BridgeDevice | undefined {
  const wantedMac = normalizeMac(target)
  if (wantedMac !== '') {
    const match = devices.find(device => device.mac === wantedMac)
    if (match !== undefined) return match
  }
  const wanted = target.toLowerCase()
  if (wanted !== '') {
    const match = devices.find(device => {
      return device.alias.toLowerCase() === wanted
        || device.name.toLowerCase() === wanted
        || device.ip === target
    })
    if (match !== undefined) return match
  }
  return devices.length === 1 ? devices[0] : undefined
}

async function postBridgePilot(options: ResolvedOptions, target: string, params: JsonObject): Promise<void> {
  const response = await fetch(bridgeEndpoint(options.url, 'pilot'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target, params }),
    signal: AbortSignal.timeout(options.httpTimeoutMs),
  })
  const text = await response.text()
  let data: JsonObject = {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (isObject(parsed)) data = parsed
  } catch {
    // reported below
  }
  if (!response.ok) throw new Error(`wiz-flash: bridge pilot HTTP ${response.status}: ${text.slice(0, 200)}`)
  if (data.ok === false) throw new Error(`wiz-flash: bridge pilot rejected the change: ${text.slice(0, 200)}`)
}

async function fadeApprovalRestoreUdp(
  link: BulbLink,
  state: PilotState,
  fromRgb: [number, number, number],
  fromLevel: number,
  settings: FlashSettings,
): Promise<void> {
  const steps = Math.max(2, settings.steps)
  const stepSleep = Math.max(0, settings.fadeMs) / steps
  const targetRgb: [number, number, number] = state.on ? endColor(state) : [0, 0, 0]
  const targetLevel = state.on ? state.dimming ?? 10 : 10
  try {
    for (let index = 1; index <= steps; index += 1) {
      const t = smoothstep(index / steps)
      const rgb = lerpRgb(fromRgb, targetRgb, t)
      const level = Math.round(fromLevel + (targetLevel - fromLevel) * t)
      await link.setPilot({ state: true, r: rgb[0], g: rgb[1], b: rgb[2], dimming: Math.max(10, level) })
      await sleep(stepSleep)
    }
  } catch {
    // Fall through to the exact restore; a dropped fade frame is not fatal.
  }
  await link.setPilot(restoreParams(state))
}

async function fadeApprovalRestoreHttp(
  options: ResolvedOptions,
  target: string,
  state: PilotState,
  fromRgb: [number, number, number],
  fromLevel: number,
  settings: FlashSettings,
): Promise<void> {
  const steps = Math.max(2, settings.steps)
  const stepSleep = Math.max(0, settings.fadeMs) / steps
  const targetRgb: [number, number, number] = state.on ? endColor(state) : [0, 0, 0]
  const targetLevel = state.on ? state.dimming ?? 10 : 10
  try {
    for (let index = 1; index <= steps; index += 1) {
      const t = smoothstep(index / steps)
      const rgb = lerpRgb(fromRgb, targetRgb, t)
      const level = Math.round(fromLevel + (targetLevel - fromLevel) * t)
      await postBridgePilot(options, target, {
        state: true,
        r: rgb[0],
        g: rgb[1],
        b: rgb[2],
        dimming: Math.max(10, level),
      })
      await sleep(stepSleep)
    }
  } catch {
    // Fall through to the exact restore.
  }
  await postBridgePilot(options, target, restoreParams(state))
}

async function beginUdpApprovalGlow(options: ResolvedOptions, settings: FlashSettings): Promise<ApprovalGlow | undefined> {
  const bulb = await resolveBulb(options, settings)
  const link = new BulbLink(bulb.ip, options.port, bulb.key, options.timeoutMs)
  const state = await link.getPilot()
  if (!state.on && options.approvalWhenOff === 'skip') return undefined
  const rgb = hexToRgb(options.approvalColor)
  const level = Math.max(10, options.approvalBrightness)
  await link.setPilot({
    state: true,
    r: rgb[0],
    g: rgb[1],
    b: rgb[2],
    dimming: level,
  })
  return {
    restore: async () => {
      await fadeApprovalRestoreUdp(link, state, rgb, level, settings)
    },
  }
}

async function beginHttpApprovalGlow(options: ResolvedOptions, settings: FlashSettings): Promise<ApprovalGlow | undefined> {
  const devices = await fetchBridgeDevices(options)
  const target = settings.target || options.target
  const device = findBridgeDevice(devices, target)
  if (device === undefined) {
    throw new Error('wiz-flash: approval glow needs a target when the bridge reports multiple bulbs')
  }
  if (!device.online) throw new Error(`wiz-flash: bridge reports ${device.mac || target} offline`)
  if (device.state === undefined) throw new Error('wiz-flash: bridge did not report the bulb state')

  const state = parsePilot(device.state)
  if (!state.on && options.approvalWhenOff === 'skip') return undefined
  const rgb = hexToRgb(options.approvalColor)
  const level = Math.max(10, options.approvalBrightness)
  const pilotTarget = device.mac || target
  await postBridgePilot(options, pilotTarget, {
    state: true,
    r: rgb[0],
    g: rgb[1],
    b: rgb[2],
    dimming: level,
  })
  return {
    restore: async () => {
      await fadeApprovalRestoreHttp(options, pilotTarget, state, rgb, level, settings)
    },
  }
}

async function beginApprovalGlow(
  options: ResolvedOptions,
  settings: FlashSettings,
  cache: { transport?: Transport },
): Promise<ApprovalGlow | undefined> {
  if (options.mode === 'http') return beginHttpApprovalGlow(options, settings)
  if (options.mode === 'udp') return beginUdpApprovalGlow(options, settings)
  if (cache.transport === 'http') return beginHttpApprovalGlow(options, settings)
  if (cache.transport === 'udp') {
    try {
      return await beginUdpApprovalGlow(options, settings)
    } catch (error) {
      if (options.url === '') throw error
      const glow = await beginHttpApprovalGlow(options, settings)
      cache.transport = 'http'
      return glow
    }
  }

  const localHint = options.ip !== ''
    || options.credentialsPath !== ''
    || settings.target !== ''
    || options.target !== ''
  if (options.url !== '' && !localHint) {
    const glow = await beginHttpApprovalGlow(options, settings)
    cache.transport = 'http'
    return glow
  }

  try {
    const glow = await beginUdpApprovalGlow(options, settings)
    cache.transport = 'udp'
    return glow
  } catch (error) {
    if (options.url === '') throw error
    const glow = await beginHttpApprovalGlow(options, settings)
    cache.transport = 'http'
    return glow
  }
}

async function runFlash(options: ResolvedOptions, settings: FlashSettings, cache: { transport?: Transport }): Promise<JsonObject> {
  if (options.mode === 'http') return flashHttp(options, settings)
  if (options.mode === 'udp') return flashUdp(options, settings)
  if (cache.transport === 'http') return flashHttp(options, settings)
  if (cache.transport === 'udp') {
    try {
      return await flashUdp(options, settings)
    } catch (error) {
      if (options.url === '') throw error
      const result = await flashHttp(options, settings)
      cache.transport = 'http'
      return result
    }
  }

  const localHint = options.ip !== ''
    || options.credentialsPath !== ''
    || settings.target !== ''
    || options.target !== ''
  if (options.url !== '' && !localHint) {
    const result = await flashHttp(options, settings)
    cache.transport = 'http'
    return result
  }

  try {
    const result = await flashUdp(options, settings)
    cache.transport = 'udp'
    return result
  } catch (error) {
    if (options.url === '') throw error
    const result = await flashHttp(options, settings)
    cache.transport = 'http'
    return result
  }
}

function debug(ctx: WizFlashContext, options: ResolvedOptions, message: string): void {
  if (!options.debug && !asBoolean(process.env.DSH_TUI_WIZ_FLASH_DEBUG, false)) return
  try {
    ctx.logger?.debug?.(`wiz-flash: ${message}`)
  } catch {
    // a logger failure must never break the TUI
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Mount the turn-completion flash and the approval hold. The row is always
 * safe to load: with no opt-in configuration both features return
 * immediately, and the approval hold is a no-op until DSH logs its audit
 * pair.
 */
export function apply(ctx: WizFlashContext, config: WizFlashConfig = {}): void {
  const liveStarts = new Set<string>()
  const cache: { transport?: Transport } = {}
  let lastFlashAt = 0

  const approvalPending = new Map<string, string>()
  let approvalGlow: ApprovalGlow | undefined
  let approvalRestores = 0
  let approvalGeneration = 0
  let approvalSuppressed = false
  let approvalStartTimer: NodeJS.Timeout | undefined
  let approvalMaxTimer: NodeJS.Timeout | undefined
  let approvalQueue: Promise<void> = Promise.resolve()

  const safeOptions = (): ResolvedOptions | undefined => {
    try {
      return resolveOptions(config)
    } catch {
      return undefined
    }
  }

  const enqueueApproval = (operation: () => Promise<void>): void => {
    approvalQueue = approvalQueue.then(operation, operation)
  }

  /**
   * Stop the current hold and fence any in-flight start. The generation bump
   * is what makes a late `beginApprovalGlow` restore its own just-applied
   * color instead of leaking it after a quick approval.
   */
  const endApprovalCycle = (reason: string): void => {
    approvalGeneration += 1
    if (approvalStartTimer !== undefined) {
      clearTimeout(approvalStartTimer)
      approvalStartTimer = undefined
    }
    if (approvalMaxTimer !== undefined) {
      clearTimeout(approvalMaxTimer)
      approvalMaxTimer = undefined
    }

    const glow = approvalGlow
    approvalGlow = undefined
    if (glow !== undefined) {
      approvalRestores += 1
      enqueueApproval(async () => {
        try {
          await glow.restore()
        } catch (error) {
          const options = safeOptions()
          if (options !== undefined) debug(ctx, options, `approval restore failed (${reason}): ${messageOf(error)}`)
        } finally {
          approvalRestores -= 1
        }
      })
    }
    if (approvalPending.size === 0) approvalSuppressed = false
  }

  const beginApprovalCycle = (): void => {
    approvalGeneration += 1
    const generation = approvalGeneration
    const options = safeOptions()
    if (options === undefined || !options.enabled || !options.approvalGlow) return

    if (approvalStartTimer !== undefined) clearTimeout(approvalStartTimer)
    approvalStartTimer = setTimeout(() => {
      approvalStartTimer = undefined
      enqueueApproval(async () => {
        if (generation !== approvalGeneration) return
        if (approvalPending.size === 0 || approvalGlow !== undefined) return

        let glow: ApprovalGlow | undefined
        try {
          glow = await beginApprovalGlow(options, options.settings, cache)
        } catch (error) {
          debug(ctx, options, `approval glow failed: ${messageOf(error)}`)
          return
        }
        if (glow === undefined) return

        if (generation !== approvalGeneration || approvalPending.size === 0) {
          approvalRestores += 1
          try {
            await glow.restore()
          } catch {
            // best effort: the approval was decided while the state was read
          } finally {
            approvalRestores -= 1
          }
          return
        }

        approvalGlow = glow
        if (approvalMaxTimer !== undefined) clearTimeout(approvalMaxTimer)
        approvalMaxTimer = setTimeout(() => {
          approvalMaxTimer = undefined
          approvalSuppressed = true
          endApprovalCycle('max-duration')
        }, options.approvalMaxMs)
      })
    }, options.approvalStartDelayMs)
  }

  const noteApprovalAsked = (id: string, sessionId: string): void => {
    if (id === '' || approvalPending.has(id)) return
    const wasEmpty = approvalPending.size === 0
    approvalPending.set(id, sessionId)
    if (!wasEmpty) return
    if (approvalSuppressed) return
    beginApprovalCycle()
  }

  const noteApprovalDecided = (id: string): void => {
    if (!approvalPending.delete(id)) return
    if (approvalPending.size === 0) endApprovalCycle('decided')
  }

  const trigger = (): void => {
    // An approval is a blocking notification; a turn-completion flash must
    // not repaint the bulb underneath the held approval color or its
    // fade-out.
    if (approvalPending.size > 0 || approvalGlow !== undefined || approvalRestores > 0) return

    const options = safeOptions()
    if (options === undefined || !options.enabled || !options.turnEndFlash) return

    const now = Date.now()
    const cooldown = options.settings.cooldownMs ?? options.cooldownMs
    if (now - lastFlashAt < cooldown) return
    lastFlashAt = now

    void runFlash(options, options.settings, cache).catch(error => {
      debug(ctx, options, messageOf(error))
    })
  }

  ctx.on('session/disposed', session => {
    const sessionId = session?.id === undefined ? '' : String(session.id)
    if (sessionId !== '') liveStarts.delete(sessionId)
    if (sessionId === '') return

    let removed = false
    for (const [id, owner] of approvalPending) {
      if (owner !== sessionId) continue
      approvalPending.delete(id)
      removed = true
    }
    if (removed && approvalPending.size === 0) endApprovalCycle('session-disposed')
  })

  ctx.on('session/event', (session, event) => {
    if (session === undefined || event === undefined) return
    const sessionId = session.id === undefined ? '' : String(session.id)

    // DSH's approval service appends this audit pair for every ask,
    // including explicit rejections and cancellations. The pair is the
    // stable, log-only signal that a prompt is waiting for the user.
    if (event.type === 'approval/asked') {
      const id = asString(event.data?.id)
      if (id !== '') noteApprovalAsked(id, sessionId)
      return
    }
    if (event.type === 'approval/decided') {
      const id = asString(event.data?.id)
      if (id !== '') noteApprovalDecided(id)
      return
    }

    if (event.type === 'turn/start') {
      if (sessionId !== '') liveStarts.add(sessionId)
      return
    }
    if (event.type !== 'turn/end') return

    const live = sessionId === '' ? false : liveStarts.delete(sessionId)
    if (!live && asBoolean(config.requireLiveStart, false)) return
    if (session.header?.origin === 'subagent') return
    if ((session.header?.delegationDepth ?? 0) > 0) return

    const reason = event.data?.reason
    const kind = typeof reason === 'string' ? reason : reason?.kind
    if (kind !== 'completed') return
    trigger()
  })

  ctx.effect?.(() => () => {
    // Unloading the plugin (TUI exit or a live reload) must not leave the
    // bulb held on the approval color.
    approvalSuppressed = true
    endApprovalCycle('dispose')
  })
}

export default apply
