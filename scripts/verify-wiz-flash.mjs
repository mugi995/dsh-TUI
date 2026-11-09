#!/usr/bin/env node
/**
 * Offline regression for the built-in WiZ completion flash.
 *
 * Starts a fake WiZ bulb (UDP 38899-compatible JSON) and a fake wizctl HTTP
 * bridge, then drives the plugin's `session/event` handlers. Covers:
 *   - UDP fade up/down and exact-state restore (white temperature mode)
 *   - subagent turns, non-completed endings, and the default-off switch
 *   - HTTP bridge mode and auto fallback when the bulb LAN is unreachable
 *   - the new-firmware signed-write retry (HMAC over compact params JSON)
 *   - `whenOff: flash`, the stale-lock path, and the on-disk opt-in config
 *
 * Run: node --import tsx/esm scripts/verify-wiz-flash.mjs
 */
import { createHmac } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-wiz-flash-'))
process.env.HOME = home
process.env.USERPROFILE = home
for (const key of Object.keys(process.env)) {
  if (key.startsWith('DSH_TUI_WIZ_FLASH')) delete process.env[key]
}
mkdirSync(join(home, '.dsh-tui'), { recursive: true })

const { apply } = await import('../src/wiz-flash.ts')

const results = []
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

function check(label, condition) {
  if (!condition) throw new Error(`FAIL: ${label}`)
  results.push(label)
  console.log(`  ✓ ${label}`)
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('FAIL: timed out waiting for the flash')
    await delay(10)
  }
}

function createContext() {
  const handlers = new Map()
  return {
    ctx: {
      on(event, listener) {
        handlers.set(event, listener)
        return () => handlers.delete(event)
      },
    },
    emit(event, ...args) {
      handlers.get(event)?.(...args)
    },
  }
}

function session(id, header = { origin: 'main' }) {
  return { id, header }
}

function completed() {
  return { type: 'turn/end', data: { reason: { kind: 'completed' } } }
}

function start(id = 'main') {
  return { type: 'turn/start', data: {} }
}

function emitCompleted(context, id = 'main', header) {
  context.emit('session/event', session(id, header), start(id))
  context.emit('session/event', session(id, header), completed())
}

async function startMockBulb({ signedOnly = false, off = false } = {}) {
  const socket = createSocket('udp4')
  const calls = []
  const state = {
    mac: 'aabbccddeeff',
    state: !off,
    dimming: 40,
    temp: 2_200,
    sceneId: 0,
    r: null,
    g: null,
    b: null,
  }

  socket.on('message', (data, remote) => {
    let message
    try {
      message = JSON.parse(data.toString('utf8'))
    } catch {
      return
    }
    calls.push(message)
    const respond = payload => {
      socket.send(JSON.stringify(payload), remote.port, remote.address)
    }
    if (message.method === 'getPilot') {
      respond({ method: 'getPilot', result: { ...state } })
      return
    }
    if (message.method !== 'setPilot') return
    if (signedOnly && typeof message.hmac !== 'string') {
      respond({ method: 'setPilot', error: { code: -32_602, message: 'Invalid params' } })
      return
    }
    Object.assign(state, message.params)
    respond({ method: 'setPilot', result: { success: true } })
  })

  await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve))
  return {
    port: socket.address().port,
    calls,
    state,
    close: () => new Promise(resolve => socket.close(resolve)),
  }
}

async function startHttpBridge() {
  const requests = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => {
      body += chunk
    })
    request.on('end', () => {
      let parsed = {}
      try {
        parsed = JSON.parse(body)
      } catch {
        // the plugin sends JSON; a malformed body is still a failed assertion
      }
      requests.push({ url: request.url, body: parsed })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, flashed: true }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}/api/flash/test`,
    requests,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

async function unusedUdpPort() {
  const socket = createSocket('udp4')
  await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve))
  const port = socket.address().port
  await new Promise(resolve => socket.close(resolve))
  return port
}

const baseConfig = port => ({
  enabled: true,
  mode: 'udp',
  ip: '127.0.0.1',
  port,
  target: 'aabbccddeeff',
  color: '#2f6bff',
  brightness: 60,
  fadeMs: 10,
  holdMs: 5,
  steps: 2,
  cooldownMs: 0,
  timeoutMs: 500,
})

try {
  console.log('wiz-flash: UDP fade + restore')
  const bulb = await startMockBulb()
  const udp = createContext()
  apply(udp.ctx, { ...baseConfig(bulb.port), lockPath: join(home, 'udp.lock') })
  emitCompleted(udp)
  await waitFor(() => bulb.calls.some(call => call.method === 'setPilot' && call.params.temp === 2_200))

  check('first request is getPilot', bulb.calls[0]?.method === 'getPilot')
  const setCalls = bulb.calls.filter(call => call.method === 'setPilot')
  check('fade has up, down, and restore frames', setCalls.length >= 5)
  check('the flash reaches the requested blue', setCalls.some(call => call.params.r === 0x2f && call.params.g === 0x6b && call.params.b === 0xff))
  const restored = setCalls.at(-1)?.params
  check('restore keeps the original temperature and dimming', restored?.state === true && restored?.temp === 2_200 && restored?.dimming === 40)
  check('restore does not invent an RGB value for white mode', restored?.r === undefined && restored?.g === undefined && restored?.b === undefined)

  console.log('wiz-flash: excluded turns')
  bulb.calls.length = 0
  emitCompleted(udp, 'sub', { origin: 'subagent' })
  await delay(150)
  check('subagent turn does not flash', bulb.calls.length === 0)

  udp.emit('session/event', session('interrupted'), start('interrupted'))
  udp.emit('session/event', session('interrupted'), { type: 'turn/end', data: { reason: { kind: 'interrupted' } } })
  await delay(150)
  check('interrupted turn does not flash', bulb.calls.length === 0)

  const disabled = createContext()
  apply(disabled.ctx, { ...baseConfig(bulb.port), enabled: false, lockPath: join(home, 'disabled.lock') })
  emitCompleted(disabled)
  await delay(150)
  check('default-off configuration stays silent', bulb.calls.length === 0)

  console.log('wiz-flash: HTTP bridge')
  const bridge = await startHttpBridge()
  const http = createContext()
  apply(http.ctx, {
    enabled: true,
    mode: 'http',
    url: bridge.url,
    target: 'aabbccddeeff',
    color: '#123456',
    brightness: 70,
    fadeMs: 20,
    holdMs: 10,
    steps: 3,
    cooldownMs: 0,
  })
  emitCompleted(http)
  await waitFor(() => bridge.requests.length === 1)
  const posted = bridge.requests[0]?.body?.settings
  check('HTTP mode posts to the bridge', bridge.requests[0]?.url === '/api/flash/test')
  check('HTTP mode forwards the visual settings', posted?.color === '#123456' && posted?.brightness === 70 && posted?.fade_ms === 20)

  console.log('wiz-flash: auto fallback')
  bridge.requests.length = 0
  const deadPort = await unusedUdpPort()
  const auto = createContext()
  apply(auto.ctx, { ...baseConfig(deadPort), mode: 'auto', url: bridge.url, timeoutMs: 100, lockPath: join(home, 'auto.lock') })
  emitCompleted(auto)
  await waitFor(() => bridge.requests.length === 1)
  check('auto mode falls back to HTTP when the bulb LAN is unreachable', bridge.requests.length === 1)

  console.log('wiz-flash: signed writes')
  const signedBulb = await startMockBulb({ signedOnly: true })
  const signingKey = '00112233445566778899aabbccddeeff'
  const signed = createContext()
  apply(signed.ctx, { ...baseConfig(signedBulb.port), key: signingKey, lockPath: join(home, 'signed.lock') })
  emitCompleted(signed)
  await waitFor(() => signedBulb.calls.some(call => call.method === 'setPilot' && call.params.temp === 2_200))
  const signedCall = signedBulb.calls.find(call => call.method === 'setPilot' && typeof call.hmac === 'string')
  check('an unsigned rejection is retried with HMAC', signedCall !== undefined)
  if (signedCall !== undefined) {
    const params = signedCall.params
    const timestamp = params.sigTs
    const rest = { ...params }
    delete rest.sigTs
    const expected = createHmac('sha256', Buffer.from(signingKey, 'hex'))
      .update(JSON.stringify({ ...rest, sigTs: timestamp }))
      .digest('base64')
    check('the retried request carries a valid HMAC', signedCall.hmac === expected && signedCall.env === 'pro')
  }

  console.log('wiz-flash: off-state behaviour')
  const offBulb = await startMockBulb({ off: true })
  const offSkip = createContext()
  apply(offSkip.ctx, { ...baseConfig(offBulb.port), lockPath: join(home, 'off-skip.lock') })
  emitCompleted(offSkip)
  await delay(150)
  check('whenOff=skip leaves an off bulb untouched', offBulb.calls.filter(call => call.method === 'setPilot').length === 0)

  offBulb.calls.length = 0
  const offFlash = createContext()
  apply(offFlash.ctx, { ...baseConfig(offBulb.port), whenOff: 'flash', lockPath: join(home, 'off-flash.lock') })
  emitCompleted(offFlash)
  await waitFor(() => offBulb.calls.some(call => call.method === 'setPilot' && call.params.state === false))
  const offRestore = offBulb.calls.filter(call => call.method === 'setPilot').at(-1)?.params
  check('whenOff=flash returns the bulb to off', offRestore?.state === false && offRestore?.temp === 2_200)

  console.log('wiz-flash: lock and on-disk opt-in')
  const busyLock = join(home, 'busy.lock')
  writeFileSync(busyLock, 'other')
  const busy = createContext()
  apply(busy.ctx, { ...baseConfig(bulb.port), lockPath: busyLock })
  emitCompleted(busy)
  await delay(150)
  check('a live lock suppresses the flash', bulb.calls.filter(call => call.method === 'getPilot').length === 0)
  rmSync(busyLock, { force: true })

  const settingsFile = join(home, '.dsh-tui', 'flash.json')
  writeFileSync(settingsFile, JSON.stringify({
    enabled: true,
    target: 'aabbccddeeff',
    color: '#abcdef',
    brightness: 80,
    fade_ms: 10,
    hold_ms: 5,
    steps: 2,
    when_off: 'skip',
    cooldown_ms: 0,
  }))
  writeFileSync(join(home, '.dsh-tui', 'wiz-flash.json'), JSON.stringify({
    enabled: true,
    mode: 'udp',
    ip: '127.0.0.1',
    port: bulb.port,
    target: 'aabbccddeeff',
    settingsPath: settingsFile,
    lockPath: join(home, 'file.lock'),
  }))
  bulb.calls.length = 0
  const fromFile = createContext()
  apply(fromFile.ctx, {})
  emitCompleted(fromFile)
  await waitFor(() => bulb.calls.some(call => call.method === 'setPilot' && call.params.r === 0xab && call.params.g === 0xcd && call.params.b === 0xef))
  check('the on-disk bridge file opts in and reads wizctl flash.json', bulb.calls.some(call => call.method === 'setPilot' && call.params.r === 0xab))

  await bulb.close()
  await signedBulb.close()
  await offBulb.close()
  await bridge.close()
  rmSync(join(home, '.dsh-tui', 'wiz-flash.json'), { force: true })
  rmSync(settingsFile, { force: true })
  rmSync(home, { recursive: true, force: true })
  console.log(`\nwiz-flash: ${results.length} checks passed`)
} catch (error) {
  rmSync(home, { recursive: true, force: true })
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
