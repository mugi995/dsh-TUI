/** Lightweight regression checks for display settings and their stable render output. */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'
import type { QuotaSnapshot } from '../src/quota/types.js'

const [
  { strict: assert },
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render, ThemeProvider },
  { StatusLine, formatCacheHitRate },
  { AssistantToolUseMessage },
  { DEFAULT_STATUS_BAR, formatContextUsage, normalizeStatusBar, normalizeToolBackground },
  { homeDir },
  { formatProject },
] = await Promise.all([
  import('node:assert'),
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/StatusLine.js'),
  import('../src/components/messages/AssistantToolUseMessage.js'),
  import('../src/tuiDisplayPrefs.js'),
  import('../src/utils/paths.js'),
  import('../src/sessions/format.js'),
])

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

let checks = 0
function check(name: string, test: () => void): void {
  try {
    test()
    checks++
    console.log(`PASS: ${name}`)
  } catch (error) {
    console.error(`FAIL: ${name}`)
    throw error
  }
}

class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}

function makeHarness(columns = 140, rows = 12) {
  const term = new XTerm({ cols: columns, rows, scrollback: 0, allowProposedApi: true })
  const writes: string[] = []

  class FakeOutput extends Writable {
    columns = columns
    rows = rows
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
      const text = String(chunk)
      writes.push(text)
      term.write(text, callback)
    }
  }

  const stdout = new FakeOutput()
  const stderr = new FakeOutput()
  const screen = (): string => {
    const buffer = term.buffer.active
    return Array.from({ length: rows }, (_, row) =>
      buffer.getLine(row)?.translateToString(true) ?? '',
    ).join('\n')
  }

  return { term, stdout, stderr, stdin: new FakeStdin(), writes, screen }
}

const baseChannel = {
  statusBar: { ...DEFAULT_STATUS_BAR },
  agentId: 'd5a3b7c9-e1f2-4a6b-8c3d-0123456789ab',
  lastUsage: { input: 200_000, cacheRead: 5_000, cacheWrite: 1_000, output: 6_789 },
  contextWindow: 266_000,
  reasoningEffort: 'max',
  modeIndex: 0,
  mode: { id: 'default', plan: false },
  model: 'display-model-probe',
  cwd: 'C:/work/display-project',
  tokens: { input: 12_345, output: 6_789 },
  tps: 37,
  tpsSamples: [],
  working: false,
  gitBranch: 'feat/display-settings-probe',
  displayCwd: 'C:/work/display-project',
  sessionTitle: 'display settings title probe',
  activityFrames: [],
  contextBarEnabled: true,
  contextSegments: {
    system: 20_000,
    prompt: 80_000,
    assistant: 40_000,
    thinking: 30_000,
    tools: 36_000,
  },
}

const wake = {
  band: {
    buckets: [
      {
        weight: 1,
        count: 1,
        channels: { input: 0, model: 0, tool: 1 },
        error: false,
        retry: false,
        running: false,
        firstIndex: 0,
      },
    ],
    peak: 1,
    floor: 1,
    turns: [[1, 0]],
  },
  tick: 0,
}

async function renderStatus(
  overrides: Record<string, unknown> = {},
  columns = 140,
  options: { selectionActive?: boolean; helpOpen?: boolean; quota?: QuotaSnapshot } = {},
): Promise<string> {
  const harness = makeHarness(columns)
  const channel = { ...baseChannel, ...overrides }
  const instance = await render(
    <ThemeProvider theme="dark">
      <StatusLine
        channel={channel as never}
        wake={wake as never}
        selectionActive={options.selectionActive}
        helpOpen={options.helpOpen}
        quota={options.quota}
      />
    </ThemeProvider>,
    {
      stdout: harness.stdout as NodeJS.WriteStream,
      stderr: harness.stderr as NodeJS.WriteStream,
      stdin: harness.stdin as NodeJS.ReadStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  await sleep(180)
  const output = harness.screen()
  await instance.unmount()
  harness.term.dispose()
  return output
}

// Defaults and normalization.
check('DEFAULT_STATUS_BAR keeps the intended compact defaults', () => {
  assert.deepEqual(DEFAULT_STATUS_BAR, {
    compact: true,
    model: true,
    thinking: true,
    cwd: true,
    contextUsage: true,
    cache: true,
    quota: true,
    cost: true,
    tokens: false,
    tps: false,
    gitBranch: false,
    sessionTitle: false,
    sessionId: false,
    goal: true,
    mode: false,
    contextBar: true,
    // The bar's look is a separate switch; the default keeps the five
    // content-type segments, so existing users see no visual drift.
    contextBarStyle: 'segments',
    activity: false,
    trajectory: false,
    shortcutHint: false,
    // Plugin footer fields (tuiStatus.setField): on by default, and the list
    // starts at `*` so an upgrade changes nothing.
    pluginFields: true,
    pluginFieldsOrder: '*',
  })
})

check('normalizeStatusBar merges booleans over defaults only', () => {
  assert.deepEqual(normalizeStatusBar({ compact: false, tps: true, model: 'no', unknown: true }), {
    ...DEFAULT_STATUS_BAR,
    compact: false,
    tps: true,
  })
})

check('normalizeStatusBar rejects invalid top-level values', () => {
  for (const invalid of [undefined, null, false, 'compact', 1, [], () => {}]) {
    assert.deepEqual(normalizeStatusBar(invalid), DEFAULT_STATUS_BAR)
  }
})

// Metric formatting.
check('formatContextUsage emits compact percent and token counts', () => {
  const formatted = formatContextUsage(206_000, 266_000, true)
  assert.equal(formatted, '77% (206k/266k)')
})

check('formatContextUsage omits unknown or invalid capacities', () => {
  assert.equal(formatContextUsage(206_000, undefined, true), undefined)
  assert.equal(formatContextUsage(206_000, 0, true), undefined)
  assert.equal(formatContextUsage(206_000, Number.NaN, true), undefined)
})

check('formatCacheHitRate accepts usable snapshots and rejects invalid totals', () => {
  assert.equal(formatCacheHitRate({ input: 200_000, cacheRead: 5_000, cacheWrite: 1_000 }), '2.4%')
  assert.equal(formatCacheHitRate(undefined), undefined)
  assert.equal(formatCacheHitRate({ input: 0, cacheRead: 0, cacheWrite: 0 }), undefined)
  assert.equal(formatCacheHitRate({ input: Number.NaN, cacheRead: 1, cacheWrite: 0 }), undefined)
})

// StatusLine compact defaults.
const compact = await renderStatus()
check('compact StatusLine shows the ctx/cache readout under the bar', () => {
  // model / effort moved to the prompt border; cwd moved there too. The
  // footer's remaining readout is the dedicated line under the gauge.
  for (const marker of ['ctx 206k/266k 77.4%', 'cache 2.4%']) {
    assert.ok(compact.includes(marker), `missing ${JSON.stringify(marker)} in:\n${compact}`)
  }
  assert.ok(!compact.includes('display-project'), `footer still shows the cwd:\n${compact}`)
})

check('formatProject collapses home paths for the cwd label', () => {
  const home = homeDir()
  assert.equal(formatProject(home, home), '~')
  assert.equal(formatProject(`${home}/dev/display-project`, home), '~/dev/display-project')
  assert.equal(formatProject('/opt/display-project', home), '/opt/display-project')
})

check('compact StatusLine hides disabled optional fields', () => {
  for (const marker of ['37 t/s', 'feat/display-settings-probe', 'display settings title probe', '#d5a3b7c9', '12.3k→6.8k']) {
    assert.ok(!compact.includes(marker), `unexpected ${JSON.stringify(marker)} in:\n${compact}`)
  }
  assert.ok(!/[▁▂▃▄▅▆▇█▶]/.test(compact), `unexpected trajectory wake in:\n${compact}`)
})

check('compact StatusLine shows the context bar by default', () => {
  // Defaults flipped on 2026-09-10: the bar renders without any /settings edit.
  // The bar is fill-only and now carries NO text at all (the readout moved to
  // the ctx/cache line directly under it), so the bar row is blank in the
  // string rendering and the line below carries the numbers.
  const [barRow = '', ctxRow = ''] = compact.split('\n')
  assert.equal(barRow.trim(), '', `unexpected text on the bar row:\n${barRow}`)
  assert.ok(ctxRow.includes('ctx 206k/266k 77.4% cache 2.4%'), `missing ctx/cache row:\n${ctxRow}`)
})

const minimalUi = await renderStatus({ minimalUi: true })
check('minimal UI StatusLine stays free of the context bar', () => {
  // The minimal UI pins its decoration switches OFF instead of inheriting them:
  // the default flip above must not leak a bar row into the trimmed footer.
  // The ctx line under the (absent) bar also spells 77.4%, so pin the BAR
  // ROW shape rather than the string.
  assert.ok(!minimalUi.split('\n').some(line => /^\s*206k\/266k 77\.4%$/.test(line)),
    `unexpected context-bar row in:\n${minimalUi}`)
  assert.ok(!minimalUi.includes('system'), `unexpected context-bar segment in:\n${minimalUi}`)
})

const quota: QuotaSnapshot = {
  fetchedAt: 0,
  providers: [
    {
      id: 'ollama',
      label: 'Ollama Cloud',
      credits: { remaining: 72.5, limit: 100, currency: 'USD' },
      windows: [{ id: 'included', usedPercent: 27.5 }],
    },
    {
      id: 'opencode-go',
      label: 'OpenCode Go',
      windows: [
        { id: 'five-hour', usedPercent: 40 },
        { id: 'weekly', usedPercent: 78 },
        { id: 'monthly', usedPercent: 82 },
      ],
    },
    {
      id: 'command-code',
      label: 'Command Code',
      plan: 'GOAT',
      credits: { remaining: 73.03, currency: 'USD' },
      windows: [
        { id: 'five-hour', usedPercent: 12 },
        { id: 'weekly', usedPercent: 11 },
      ],
    },
    {
      id: 'openrouter',
      label: 'OpenRouter',
      credits: { remaining: 87.5, limit: 100, currency: 'USD' },
      windows: [{ id: 'budget-weekly', usedPercent: 80 }],
    },
  ],
}
const quotaStatus = await renderStatus({}, 140, { quota })
check('subscription quota block sits to the right of the ctx/cache line', () => {
  const lines = quotaStatus.split('\n')
  const ctx = lines.findIndex(line => line.includes('ctx 206k/266k'))
  assert.ok(ctx >= 0, `missing ctx line in:\n${quotaStatus}`)
  const ctxLine = lines[ctx] ?? ''
  // The first quota row shares the ctx/cache row; the remaining quota
  // windows continue in the right-hand column below it.
  assert.ok(ctxLine.includes('cache 2.4%') && /ollama\s+\$72\.50\/\$100/.test(ctxLine) && ctxLine.includes('1m [###-------]28%'), ctxLine)
  const go = lines[ctx + 1]?.trimStart() ?? ''
  const command = lines[ctx + 2]?.trimStart() ?? ''
  const openrouter = lines[ctx + 3]?.trimStart() ?? ''
  assert.ok(go.startsWith('opencode go ') && go.includes('5h [####------]40%') && go.includes('1m [########--]82%'), go)
  assert.ok(command.startsWith('command code ') && command.includes('$73.03') && command.includes('5h [#---------]12%'), command)
  assert.ok(openrouter.startsWith('openrouter ') && openrouter.includes('$87.50/$100') && openrouter.includes('1w [########--]80%'), openrouter)
})

const quotaOff = await renderStatus({ statusBar: { ...DEFAULT_STATUS_BAR, quota: false } }, 140, { quota })
check('quota display switch hides the quota column without touching ctx/cache', () => {
  assert.ok(quotaOff.includes('ctx 206k/266k'), quotaOff)
  assert.ok(!quotaOff.includes('ollama') && !quotaOff.includes('opencode go') && !quotaOff.includes('command code'), quotaOff)
})

const withSessionId = await renderStatus({
  statusBar: { ...DEFAULT_STATUS_BAR, sessionId: true },
})
check('session id switch shows the # + 8-char short id', () => {
  assert.ok(withSessionId.includes('#d5a3b7c9'), `missing short session id in:\n${withSessionId}`)
  assert.ok(!withSessionId.includes('d5a3b7c9-e1f2'), `full id leaked in:\n${withSessionId}`)
})

check('compact StatusLine hides the shortcuts hint by default', () => {
  assert.equal((compact.match(/\? for shortcuts/g) ?? []).length, 0)
})

const compactWithShortcutHint = await renderStatus({
  statusBar: { ...DEFAULT_STATUS_BAR, shortcutHint: true },
})
check('compact StatusLine renders the enabled shortcuts hint exactly once', () => {
  assert.equal((compactWithShortcutHint.match(/\? for shortcuts/g) ?? []).length, 1)
})

const probeGoal = {
  id: 'g-probe',
  revision: 1,
  objective: 'probe goal objective',
  phase: 'active',
  maxGoalRounds: 5,
  roundsStarted: 2,
} as const

const withGoal = await renderStatus({ goal: probeGoal })
check('compact StatusLine renders the goal chip when a goal exists', () => {
  assert.ok(withGoal.includes('● 2/5'), `missing goal chip in:\n${withGoal}`)
})

const withGoalHidden = await renderStatus({
  goal: probeGoal,
  statusBar: { ...DEFAULT_STATUS_BAR, goal: false },
})
check('goal chip respects the statusBar.goal switch', () => {
  assert.ok(!withGoalHidden.includes('2/5'), `unexpected goal chip in:\n${withGoalHidden}`)
})

const working = await renderStatus({ working: true })
check('working StatusLine always renders its Esc interrupt hint', () => {
  assert.equal((working.match(/esc to interrupt/g) ?? []).length, 1)
})

const selecting = await renderStatus({}, 140, { selectionActive: true })
check('selection StatusLine always renders its Esc return hint', () => {
  assert.equal((selecting.match(/esc to return to input/g) ?? []).length, 1)
})

for (const columns of [84, 100, 126]) {
  const narrow = await renderStatus({
    statusBar: {
      ...DEFAULT_STATUS_BAR,
      tokens: true,
      tps: true,
      gitBranch: true,
      sessionTitle: true,
      mode: true,
    },
    modeIndex: 1,
    mode: { id: 'plan', plan: true },
    contextWindow: 1_000_000,
    lastUsage: { input: 9_000, cacheRead: 100, cacheWrite: 0, output: 6_789 },
  }, columns)
  check(`compact ctx/cache readout renders once under the bar at ${columns} cols`, () => {
    const line = narrow.split('\n').find(row => row.includes('ctx 9.1k/1.0M 0.9%'))
    assert.ok(line, `missing context readout in:\n${narrow}`)
    assert.equal(line?.match(/ctx 9\.1k\/1\.0M 0\.9%/g)?.length, 1)
  })
}

// Full / all-switches-on scenario. Stable feature markers avoid a whole-screen snapshot.
const fullStatus = {
  ...DEFAULT_STATUS_BAR,
  compact: false,
  tokens: true,
  tps: true,
  gitBranch: true,
  sessionTitle: true,
  sessionId: true,
  contextBar: true,
  trajectory: true,
}
const full = await renderStatus({ statusBar: fullStatus }, 200)
check('full StatusLine exposes tps, git, title, and token totals', () => {
  for (const marker of ['37 t/s', 'feat/display-settings-probe', 'display settings title probe', '#d5a3b7c9', '12.3k→6.8k']) {
    assert.ok(full.includes(marker), `missing ${JSON.stringify(marker)} in:\n${full}`)
  }
})

check('full StatusLine renders context bar and deterministic trajectory wake', () => {
  // Row 1 is the fill-only bar (no text); row 2 carries the ctx/cache
  // numbers now that the in-bar readout is gone.
  const [barRow = '', ctxRow = ''] = full.split('\n')
  assert.equal(barRow.trim(), '', `unexpected text on the bar row:\n${barRow}`)
  assert.ok(ctxRow.includes('ctx 206k/266k 77.4% cache 2.4%'), `missing ctx/cache row:\n${ctxRow}`)
  assert.ok(/[▁▂▃▄▅▆▇█]/.test(full), `missing trajectory glyph in:\n${full}`)
})

// StatusLine ≈¥ field reads the per-model cost buckets (#1089): it appears for
// an official provider with a known price, and the statusBar.cost switch hides it.
const costProbe = {
  provider: 'deepseek',
  mainCost: {
    'deepseek-v4-flash': {
      peak: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
      idle: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  },
}
const withCost = await renderStatus(costProbe)
check('status line renders the session cost estimate for a priced model', () => {
  assert.ok(withCost.includes('≈¥2.00'), `missing cost estimate in:\n${withCost}`)
})
const withoutCost = await renderStatus({
  ...costProbe,
  statusBar: { ...DEFAULT_STATUS_BAR, cost: false },
})
check('statusBar.cost switch still hides the cost field', () => {
  assert.ok(!withoutCost.includes('≈¥'), `unexpected cost estimate in:\n${withoutCost}`)
})

// Tool background normalization and terminal ANSI output.
check('normalizeToolBackground accepts the three modes and falls back to none', () => {
  assert.equal(normalizeToolBackground('none'), 'none')
  assert.equal(normalizeToolBackground('subtle'), 'subtle')
  assert.equal(normalizeToolBackground('strong'), 'strong')
  assert.equal(normalizeToolBackground('loud'), 'none')
  assert.equal(normalizeToolBackground(undefined), 'none')
})

async function renderToolBackground(toolBackground: 'none' | 'subtle' | 'strong'): Promise<string> {
  const harness = makeHarness(80, 6)
  const tool = {
    callId: `background-${toolBackground}`,
    name: 'read',
    argsText: '{"path":"display-settings.txt"}',
    status: 'ok' as const,
    durationMs: 12,
    resultFull: 'background probe output',
  }
  const instance = await render(
    <ThemeProvider theme="dark">
      <AssistantToolUseMessage
        tool={tool as never}
        marginTopOnTurn={false}
        verbose={false}
        toolBackground={toolBackground}
      />
    </ThemeProvider>,
    {
      stdout: harness.stdout as NodeJS.WriteStream,
      stderr: harness.stderr as NodeJS.WriteStream,
      stdin: harness.stdin as NodeJS.ReadStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  await sleep(180)
  await instance.unmount()
  harness.term.dispose()
  return harness.writes.join('')
}

const noneAnsi = await renderToolBackground('none')
const subtleAnsi = await renderToolBackground('subtle')
const strongAnsi = await renderToolBackground('strong')
check('tool background modes map to stable dark-theme ANSI backgrounds', () => {
  const subtleBg = '\x1b[48;2;28;35;48m'
  const strongBg = '\x1b[48;2;36;43;58m'
  assert.ok(!noneAnsi.includes(subtleBg) && !noneAnsi.includes(strongBg))
  assert.ok(subtleAnsi.includes(subtleBg), 'subtle background ANSI missing')
  assert.ok(strongAnsi.includes(strongBg), 'strong background ANSI missing')
})

console.log(`\nAll ${checks} display-settings checks passed.`)
