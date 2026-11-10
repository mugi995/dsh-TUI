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
  const disposers = []
  return {
    ctx: {
      on(event, listener) {
        handlers.set(event, listener)
        return () => handlers.delete(event)
      },
      logger: { debug: message => console.log(`debug: ${message}`) },
      effect(setup) {
        disposers.push(setup())
      },
    },
    emit(event, ...args) {
      handlers.get(event)?.(...args)
    },
    dispose() {
      for (const dispose of disposers.splice(0)) dispose()
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
    // A real WiZ bulb keeps one light mode at a time: setting a white
    // temperature clears RGB, and setting RGB clears the temperature.
    if (message.params.temp !== undefined) {
      state.r = null
      state.g = null
      state.b = null
      state.sceneId = 0
    } else if (message.params.r !== undefined || message.params.g !== undefined || message.params.b !== undefined) {
      state.temp = null
      state.sceneId = 0
    } else if (message.params.sceneId !== undefined) {
      state.r = null
      state.g = null
      state.b = null
      state.temp = null
    }
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
  const device = {
    mac: 'aabbccddeeff',
    alias: 'mock',
    name: 'Mock bulb',
    ip: '127.0.0.1',
    online: true,
    state: {
      state: true,
      is_on: true,
      dimming: 40,
      temp: 2_200,
      scene_id: 0,
      r: null,
      g: null,
      b: null,
    },
  }
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
      const url = request.url ?? ''
      requests.push({ method: request.method, url, body: parsed })
      const json = payload => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(payload))
      }

      if (request.method === 'GET' && url.startsWith('/api/devices')) {
        json({ devices: [device], count: 1, online: 1 })
        return
      }
      if (request.method === 'POST' && url === '/api/pilot') {
        const params = parsed.params ?? {}
        Object.assign(device.state, params)
        if (params.state !== undefined) device.state.is_on = params.state
        if (params.temp !== undefined) {
          device.state.r = null
          device.state.g = null
          device.state.b = null
          device.state.scene_id = 0
        } else if (params.r !== undefined || params.g !== undefined || params.b !== undefined) {
          device.state.temp = null
          device.state.scene_id = 0
        } else if (params.sceneId !== undefined) {
          device.state.r = null
          device.state.g = null
          device.state.b = null
          device.state.temp = null
        }
        json({ ok: true, results: [{ mac: device.mac, ok: true }] })
        return
      }
      json({ ok: true, flashed: true })
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}/api/flash/test`,
    requests,
    device,
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

const setPilotCalls = bulb => bulb.calls.filter(call => call.method === 'setPilot')
const lastSetPilot = bulb => setPilotCalls(bulb).at(-1)?.params

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

  console.log('wiz-flash: approval hold (UDP)')
  const approvalBulb = await startMockBulb()
  const approval = createContext()
  apply(approval.ctx, {
    ...baseConfig(approvalBulb.port),
    approvalStartDelayMs: 0,
    approvalMaxMs: 5_000,
    debug: true,
    lockPath: join(home, 'approval.lock'),
  })
  const askApproval = (context, id) => {
    context.emit('session/event', session('approval'), { type: 'approval/asked', data: { id, toolName: 'bash' } })
  }
  const decideApproval = (context, id, outcome = 'allowed-once') => {
    context.emit('session/event', session('approval'), { type: 'approval/decided', data: { id, outcome } })
  }

  askApproval(approval, 'a1')
  await waitFor(() => setPilotCalls(approvalBulb).some(call => call.params.r === 0x2f && call.params.g === 0x6b && call.params.b === 0xff))
  check('approval hold sets the bulb blue', lastSetPilot(approvalBulb)?.r === 0x2f)
  await delay(150)
  check('the hold stays blue while the prompt is open', lastSetPilot(approvalBulb)?.r === 0x2f)

  const callsBeforeTurnEnd = approvalBulb.calls.length
  emitCompleted(approval, 'other')
  await delay(120)
  check('turn-end flash is suppressed during an approval hold', approvalBulb.calls.length === callsBeforeTurnEnd)

  decideApproval(approval, 'a1')
  await waitFor(() => lastSetPilot(approvalBulb)?.temp === 2_200)
  check('approval decision restores the original state', lastSetPilot(approvalBulb)?.temp === 2_200 && lastSetPilot(approvalBulb)?.r === undefined)

  console.log('wiz-flash: multiple approvals')
  approvalBulb.calls.length = 0
  askApproval(approval, 'a3')
  askApproval(approval, 'a4')
  await waitFor(() => setPilotCalls(approvalBulb).length > 0)
  decideApproval(approval, 'a3')
  await delay(150)
  check('one decision keeps the hold while another is pending', lastSetPilot(approvalBulb)?.r === 0x2f)
  decideApproval(approval, 'a4', 'rejected')
  await waitFor(() => lastSetPilot(approvalBulb)?.temp === 2_200)
  check('the last decision releases the hold', lastSetPilot(approvalBulb)?.temp === 2_200)

  console.log('wiz-flash: approval cleanup')
  approvalBulb.calls.length = 0
  askApproval(approval, 'a5')
  await waitFor(() => setPilotCalls(approvalBulb).length > 0)
  approval.emit('session/disposed', session('approval'))
  await waitFor(() => lastSetPilot(approvalBulb)?.temp === 2_200)
  check('session disposal releases the hold', lastSetPilot(approvalBulb)?.temp === 2_200)

  approvalBulb.calls.length = 0
  const disposed = createContext()
  apply(disposed.ctx, {
    ...baseConfig(approvalBulb.port),
    approvalStartDelayMs: 0,
    lockPath: join(home, 'disposed.lock'),
  })
  askApproval(disposed, 'dispose')
  await waitFor(() => setPilotCalls(approvalBulb).some(call => call.params.r === 0x2f))
  disposed.dispose()
  await waitFor(() => lastSetPilot(approvalBulb)?.temp === 2_200)
  check('plugin disposal releases the hold', lastSetPilot(approvalBulb)?.temp === 2_200)

  approvalBulb.calls.length = 0
  const quick = createContext()
  apply(quick.ctx, {
    ...baseConfig(approvalBulb.port),
    approvalStartDelayMs: 200,
    approvalMaxMs: 5_000,
    lockPath: join(home, 'quick.lock'),
  })
  askApproval(quick, 'quick')
  decideApproval(quick, 'quick')
  await delay(300)
  check('a quickly auto-answered ask does not flash', setPilotCalls(approvalBulb).length === 0)

  approvalBulb.calls.length = 0
  const noApproval = createContext()
  apply(noApproval.ctx, {
    ...baseConfig(approvalBulb.port),
    approvalGlow: false,
    approvalStartDelayMs: 0,
    lockPath: join(home, 'no-approval.lock'),
  })
  askApproval(noApproval, 'a6')
  await delay(200)
  check('approvalGlow=false keeps the bulb untouched', setPilotCalls(approvalBulb).length === 0)

  approvalBulb.calls.length = 0
  const maxHold = createContext()
  apply(maxHold.ctx, {
    ...baseConfig(approvalBulb.port),
    approvalStartDelayMs: 0,
    approvalMaxMs: 500,
    lockPath: join(home, 'max-hold.lock'),
  })
  askApproval(maxHold, 'a7')
  await waitFor(() => setPilotCalls(approvalBulb).some(call => call.params.r === 0x2f))
  await waitFor(() => lastSetPilot(approvalBulb)?.temp === 2_200, 2_000)
  check('approvalMaxMs releases a stuck hold', lastSetPilot(approvalBulb)?.temp === 2_200)

  console.log('wiz-flash: approval hold (HTTP)')
  bridge.requests.length = 0
  const httpApproval = createContext()
  apply(httpApproval.ctx, {
    enabled: true,
    mode: 'http',
    url: bridge.url,
    target: 'aabbccddeeff',
    approvalStartDelayMs: 0,
    approvalMaxMs: 5_000,
  })
  askApproval(httpApproval, 'a8')
  await waitFor(() => bridge.requests.some(request => request.url === '/api/pilot' && request.body.params?.r === 0x2f))
  check('HTTP approval reads the state through /api/devices', bridge.requests.some(request => request.url?.startsWith('/api/devices')))
  check('HTTP approval posts the blue hold through /api/pilot', bridge.requests.some(request => request.url === '/api/pilot' && request.body.params?.r === 0x2f))
  decideApproval(httpApproval, 'a8')
  await waitFor(() => bridge.requests.some(request => request.url === '/api/pilot' && request.body.params?.temp === 2_200))
  check('HTTP approval restores the original state through /api/pilot', bridge.requests.some(request => request.url === '/api/pilot' && request.body.params?.temp === 2_200))

  const offApprovalBulb = await startMockBulb({ off: true })
  const offApproval = createContext()
  apply(offApproval.ctx, {
    ...baseConfig(offApprovalBulb.port),
    approvalWhenOff: 'skip',
    approvalStartDelayMs: 0,
    lockPath: join(home, 'off-approval.lock'),
  })
  askApproval(offApproval, 'a9')
  await delay(200)
  check('approvalWhenOff=skip leaves an off bulb untouched', setPilotCalls(offApprovalBulb).length === 0)

  console.log('wiz-flash: approval off fade')
  const offGlowBulb = await startMockBulb({ off: true })
  const offGlow = createContext()
  apply(offGlow.ctx, {
    ...baseConfig(offGlowBulb.port),
    approvalWhenOff: 'flash',
    approvalStartDelayMs: 0,
    fadeMs: 40,
    steps: 4,
    lockPath: join(home, 'off-glow.lock'),
  })
  askApproval(offGlow, 'a10')
  await waitFor(() => setPilotCalls(offGlowBulb).some(call => call.params.r === 0x2f))
  decideApproval(offGlow, 'a10')
  await waitFor(() => lastSetPilot(offGlowBulb)?.state === false)
  const offFrames = setPilotCalls(offGlowBulb).filter(call => call.params.state === true)
  check('off approval restore fades blue down before switching off', offFrames.length >= 5 && offFrames.at(-1)?.params.dimming < 55)
  check('off approval restore ends with state=false', lastSetPilot(offGlowBulb)?.state === false)

  console.log('wiz-flash: HTTP approval off fade')
  bridge.device.state.state = false
  bridge.device.state.is_on = false
  bridge.requests.length = 0
  const httpOff = createContext()
  apply(httpOff.ctx, {
    enabled: true,
    mode: 'http',
    url: bridge.url,
    target: 'aabbccddeeff',
    approvalWhenOff: 'flash',
    approvalStartDelayMs: 0,
    fadeMs: 40,
    steps: 4,
    approvalMaxMs: 5_000,
  })
  askApproval(httpOff, 'http-off')
  await waitFor(() => bridge.requests.some(request => request.url === '/api/pilot' && request.body.params?.r === 0x2f))
  decideApproval(httpOff, 'http-off')
  await waitFor(() => bridge.requests.some(request => request.url === '/api/pilot' && request.body.params?.state === false))
  const httpPilotFrames = bridge.requests.filter(request => request.url === '/api/pilot' && request.body.params?.state === true)
  check('HTTP off approval restore fades down before switching off', httpPilotFrames.length >= 5)
  check('HTTP off approval restore ends with state=false', bridge.requests.some(request => request.url === '/api/pilot' && request.body.params?.state === false))

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
  await approvalBulb.close()
  await offApprovalBulb.close()
  await offGlowBulb.close()
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
