/**
 * Session identity regression (issue #372): the `/color` session accent,
 * the session-name label on the prompt border, and the `/recap` panel.
 *
 * Drives the real Chat command path in xterm (same harness as
 * verify-thinking-display): `/color <name>` must call channel.setSessionColor
 * and repaint the prompt border in that color (cell-level fg assertion),
 * the session title must render as a chip on the top border's RIGHT side
 * (settings `promptSessionLabel`, off by default — the chip must vanish
 * when the toggle is off), `/color reset` must clear it, and `/recap` must
 * surface the model summary + proposed title with a one-key apply through
 * renameSession.
 *
 * Every command step settles on the SCREEN showing the command's visible
 * effect (notification / local row / panel) — not on the synchronous mock
 * call — because React's commit lags the state change: typing the next
 * command before the previous render settles can drop keystrokes into a
 * stale input callback.
 *
 * Run: node --import tsx/esm scripts/verify-session-color-recap.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'
// Isolate the persisted recently-used list: the model click must land on the
// EMPTY recents tab, not whatever the developer's ~/.dsh-tui holds.
{
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const home = mkdtempSync(join(tmpdir(), 'verify-session-color-recap-'))
  process.env.HOME = home
  process.env.USERPROFILE = home
}

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render, AlternateScreen },
  { Chat },
  { setLang },
  { settle, settled, sleep, viewportLines },
  { stringWidth },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/i18n.js'),
  import('./lib/term-test.mjs'),
  import('../src/ink/stringWidth.js'),
])

const COLS = 100
const ROWS = 30
// CI's random startup tip mentioned “建议标题” after the panel had closed.
// Keep the same distractor in the transcript so every run covers that case.
const RECAP_TIP = '提示：/recap 总结近期活动并建议标题，a 键应用'
const RECAP_TITLE_ROW = '建议标题: 会话标识 PR'
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })

class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
    term.write(String(chunk), callback)
  }
}

class FakeStderr extends Writable {
  isTTY = true
  _write(_chunk: unknown, _encoding: BufferEncoding, callback: () => void) { callback() }
}

class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}

function screenText(): string {
  return viewportLines(term, ROWS).join('\n')
}

let failures = 0
function check(name: string, condition: boolean, detail = ''): void {
  console.log(`${condition ? 'PASS' : 'FAIL'}: ${name}${detail === '' ? '' : `  (${detail})`}`)
  if (!condition) failures += 1
}

/** The prompt top-border row: the line containing the `╭` corner. */
function borderRow(): { y: number; text: string } | undefined {
  const lines = viewportLines(term, ROWS)
  // The prompt border is the LAST `╭` row: picker overlays open above the
  // input and carry their own `╭` corners.
  const y = lines.findLastIndex(line => line.includes('╭'))
  return y === -1 ? undefined : { y, text: lines[y]! }
}

/** Foreground color (0xRRGGBB) of the first `─` run on the prompt border. */
function borderFgColor(): number | undefined {
  const row = borderRow()
  if (row === undefined) return undefined
  const line = term.buffer.active.getLine(row.y)
  if (line === undefined) return undefined
  for (let col = 0; col < COLS; col++) {
    const cell = line.getCell(col)
    if (cell === undefined) continue
    const ch = cell.getChars()
    if (ch === '─' || ch === '╭' || ch === '╮') {
      const fg = cell.getFgColor()
      if (fg !== 0xffffff) return fg
    }
  }
  return undefined
}

function makeChannel() {
  const listeners = new Set<() => void>()
  const setColorCalls: string[] = []
  const renameCalls: string[] = []
  /** Command-path counters for the top-border label's click targets. */
  const calls = { models: 0, providers: 0, efforts: 0 }
  const localReports: Array<{ title: string; lines: string[] }> = []
  const notifications: string[] = []
  const rows = [
    { id: 1, kind: 'user', text: '检查这个问题' },
    { id: 2, kind: 'assistant', text: `已经检查。\n${RECAP_TIP}`, streaming: false },
  ]
  const channel: any = {
    version: 0,
    rows,
    status: 'idle',
    sessionTitle: '我的会话',
    sessionColor: '',
    promptSessionLabel: true,
    agentId: 'session-identity-repro',
    model: 'deepseek-v4-flash',
    provider: 'deepseek',
    tokens: { input: 20, output: 10 },
    cwd: '/tmp',
    displayCwd: '/tmp',
    gitBranch: 'main',
    working: false,
    spinnerMode: 'requesting',
    responseChars: 0,
    activeToolCount: 0,
    turnStart: 0,
    lastUserText: '',
    pending: [],
    notifications: [],
    contextWindow: undefined,
    reasoningEffort: 'max',
    activityEnabled: false,
    contextBarEnabled: true,
    agentPreset: 'standard',
    goal: undefined,
    todos: [],
    commandList: [
      { name: 'color', description: 'Set the current session accent color' },
      { name: 'recap', description: 'Generate a recap of recent session activity' },
    ],
    commandCompletions(input: string) {
      const prefix = input.replace(/^\//u, '').trim().toLowerCase()
      return this.commandList
        .filter((command: { name: string }) => command.name.startsWith(prefix))
        .map((command: { name: string; description: string }) => ({
          ...command,
          commandLine: `/${command.name}`,
          replacement: `/${command.name} `,
        }))
    },
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    mode: { id: 'default', plan: false, sandbox: 'workspace-write', approval: 'ask' },
    modeIndex: 0,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    notify(text: string) { notifications.push(text) },
    pushLocal(title: string, lines: string[]) { localReports.push({ title, lines }) },
    setSessionColor(color: string) {
      setColorCalls.push(color)
      channel.sessionColor = color
      channel.emit()
    },
    renameSession(title: string) {
      renameCalls.push(title)
      channel.sessionTitle = title
      channel.emit()
    },
    recapRecent: async () => ({ summary: '最近在修会话颜色与 recap', title: '会话标识 PR' }),
    emit() {
      channel.version += 1
      for (const listener of listeners) listener()
    },
    submit() {},
    steer() {},
    removePending: () => true,
    cancel() {},
    interruptAndDeliver: () => 0,
    clear() {},
    loadOlder: () => 0,
    listModels: async () => {
      calls.models += 1
      return [
        { provider: 'deepseek', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
        { provider: 'other', id: 'other-1', name: 'Other One' },
      ]
    },
    listProviders: async () => { calls.providers += 1; return [] },
    listEfforts: async () => {
      calls.efforts += 1
      // Two tiers so the /effort slider actually opens (the command treats a
      // 0/1-tier list as "nothing to pick" and returns without an overlay).
      return {
        efforts: [{ id: 'low', name: 'Low' }, { id: 'max', name: 'Max' }],
        defaultEffort: 'max',
        levelsFallback: false,
      }
    },
    listFiles: async () => [],
    listSessions: async () => [],
    setResumeTarget() {},
    setActivityFrames: () => true,
    activityFrames: 'moon8',
    runExternalCommand: async () => '',
    mcpStatus: () => [],
    exportSession: () => null,
    initWorkspace: () => null,
    doctorInfo: () => [],
    pluginsInfo: () => Promise.resolve([]),
    listSubagents: async () => [],
    listPresets: async () => [],
    switchPreset: async () => false,
    switchModel: async () => false,
    rewindTo: async () => null,
    resumeTo: async () => ({ ok: false, reason: 'unavailable' }),
    newSession: async () => false,
    compact() {},
    traceEvents: () => [],
    settingsSections: () => [],
    subscribeSettingsSections: () => () => {},
    setColorCalls,
    renameCalls,
    calls,
    localReports,
    notifications,
  }
  return channel
}

setLang('zh')
const stdin = new FakeStdin()
const channel = makeChannel()
const questionStore = { subscribe: () => () => {}, getSnapshot: () => null, answerCurrent: () => {} }
const approvalStore = { subscribe: () => () => {}, getSnapshot: () => null }
const instance = await render(
  <AlternateScreen>
    <Chat
      channel={channel}
      questionStore={questionStore as any}
      approvalStore={approvalStore as any}
    />
  </AlternateScreen>,
  {
    stdout: new FakeStdout(),
    stderr: new FakeStderr(),
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
  },
)
// ── 1. session 名标签显示在输入框顶边框右上角（开关开启时）────────────
check('输入框顶边框存在', await settled(() => borderRow() !== undefined))
check('顶边框右侧渲染会话名标签（与右圆角留白）', await settled(() => {
  const text = borderRow()?.text ?? ''
  return text.includes(' 我的会话 ──[') && text.endsWith('─╮')
}), borderRow()?.text ?? '')
check('顶边框左端嵌入模型/effort读数', await settled(() => {
  const text = borderRow()?.text ?? ''
  return text.startsWith('╭─[deepseek · deepseek-v4-flash / max]──')
}), borderRow()?.text ?? '')
check('顶边框右端嵌入 cwd（方括号）', await settled(() => {
  const text = borderRow()?.text ?? ''
  return text.includes('[/tmp]─╮')
}), borderRow()?.text ?? '')
check('未设置颜色时边框为主题 promptBorder 灰蓝', await settled(() => borderFgColor() === 0x55606f), `0x${borderFgColor()?.toString(16) ?? '?'}`)

// ── 1b. 开关关闭时标签隐藏（默认关，settings `promptSessionLabel`）────
channel.promptSessionLabel = false
channel.emit()
check('关闭开关后会话名标签隐藏', await settled(() => {
  const r = borderRow()
  return r !== undefined && !r.text.includes('我的会话')
}))
channel.promptSessionLabel = true
channel.emit()
check('重新开启后标签恢复（右上角）', await settled(() => {
  const text = borderRow()?.text ?? ''
  return text.includes(' 我的会话 ──[') && text.endsWith('─╮')
}))

// ── 1c. 上边框读数的点击：模型段 → /model、思考档段 → /effort ───────────
// 这两段原来在底栏，点击行为随读数一起搬到了输入框上边框左端。
{
  await sleep(300)
  // 边框坐标：用 `╭` 行本身，而不是全屏首个匹配（启动页也有 `model · effort`
  // 文案，全屏搜索会点到那里）；列号按显示单元算。
  const clickBorder = async (needle: string): Promise<boolean> => {
    const row = borderRow()
    if (row === undefined) return false
    const at = row.text.indexOf(needle)
    if (at < 0) return false
    const col = stringWidth(row.text.slice(0, at))
    stdin.write(`\x1b[<0;${col + 1};${row.y + 1}M`)
    await sleep(40)
    stdin.write(`\x1b[<0;${col + 1};${row.y + 1}m`)
    await sleep(40)
    return true
  }
  // 模型段 → 现有的 recently-used 落地页（没有最近使用 → 空提示）。
  check('点击模型段打开 recently used',
    (await clickBorder('deepseek-v4-flash'))
    && await settled(() => screenText().includes('deepseek / DeepSeek V4 Flash')),
    JSON.stringify(viewportLines(term).filter(line => line.trim() !== '').slice(-8)))
  // 同一个读数再点一次 = 关掉（与 Esc 等价，不需要回到键盘）。两次点击
  // 拉开 500ms，避开渲染器的双击判定（双击是选词手势，不是第二次 click）。
  await sleep(600)
  check('再次点击模型段关闭 /model',
    (await clickBorder('deepseek-v4-flash')) && await settled(() => !/暂无/.test(screenText())))
  const effortsBefore = channel.calls.efforts
  check('点击思考档段触发 /effort', (await clickBorder('max')) && await settled(() => channel.calls.efforts > effortsBefore),
    `efforts=${channel.calls.efforts}`)
  check('/effort 滑块打开', await settled(() => screenText().includes('推理强度')))
  const effortsOpened = channel.calls.efforts
  // 再点同一个读数：关闭，而不是重跑 /effort（listEfforts 不再增加）。同样
  // 拉开 500ms，避开双击（选词）判定。
  await sleep(600)
  check('再次点击思考档段关闭 /effort',
    (await clickBorder('max'))
    && await settled(() => !screenText().includes('推理强度'))
    && channel.calls.efforts === effortsOpened,
    `efforts=${channel.calls.efforts}`)
  // 提供方段 → 该提供方的模型列表（不是 recents 落地页）。放在最后，
  // 避免它的选择器状态影响上面的开闭断言。
  await sleep(600)
  check('点击提供方段打开该提供方的模型列表',
    (await clickBorder('deepseek'))
    && await settled(() => screenText().includes('DeepSeek V4 Flash'))
    && !screenText().includes('deepseek / DeepSeek V4 Flash'),
    JSON.stringify(viewportLines(term).filter(line => line.trim() !== '').slice(-8)))
  stdin.write('\x1b')
  await settled(() => !screenText().includes('DeepSeek V4 Flash'))
}

// ── 2. /color <name> 设置会话强调色并重绘边框 ──────────────────────────
stdin.write('/color red')
await settle(() => screenText().includes('/color red'))
stdin.write('\r')
// 渲染完成信号 = 通知上屏（React commit 后才可见）；这个门强于下方各断言
// （屏上可见 ⇒ mock 已记录），并为下一条命令的按键 pacing——保留 settle。
await settle(() => screenText().includes('会话颜色已设为 red'))
check('/color red 调用 setSessionColor', channel.setColorCalls.length === 1, JSON.stringify(channel.setColorCalls))
check('setSessionColor 收到 red', channel.setColorCalls[0] === 'red', String(channel.setColorCalls[0]))
check('会话状态记录颜色 red', channel.sessionColor === 'red', channel.sessionColor)
check('通知说明已设置', channel.notifications.includes('会话颜色已设为 red'), JSON.stringify(channel.notifications))
check('边框重绘为会话红 #E5484D', await settled(() => borderFgColor() === 0xe5484d), `0x${borderFgColor()?.toString(16) ?? '?'}`)

// ── 3. /color status 与未知色名 ────────────────────────────────────────
stdin.write('/color status')
await settle(() => screenText().includes('/color status'))
stdin.write('\r')
await settle(() => screenText().includes('当前会话颜色'))
const statusReport = channel.localReports.find(r => r.title === '/color')
check('/color status 报告当前颜色', statusReport !== undefined && statusReport.lines[0]?.includes('red'), JSON.stringify(channel.localReports))

stdin.write('/color hotpink')
await settle(() => screenText().includes('/color hotpink'))
stdin.write('\r')
await settle(() => screenText().includes('未知颜色'))
check('未知色名报错且不写状态', channel.notifications.some(n => n.includes('未知颜色')) && channel.sessionColor === 'red')

// ── 4. /color reset 清除 ───────────────────────────────────────────────
stdin.write('/color reset')
await settle(() => screenText().includes('/color reset'))
stdin.write('\r')
await settle(() => screenText().includes('已清除会话颜色'))
check('/color reset 调用 setSessionColor(\'\')', channel.setColorCalls.length === 2 && channel.setColorCalls[1] === '', JSON.stringify(channel.setColorCalls))
check('会话颜色清空', channel.sessionColor === '', channel.sessionColor)
check('边框恢复主题色', await settled(() => borderFgColor() === 0x55606f), `0x${borderFgColor()?.toString(16) ?? '?'}`)

// ── 5. 无参 /color 打开调色板选择器，方向键 + Enter 应用 ──────────────
stdin.write('/color')
await settle(() => screenText().includes('/color'))
stdin.write('\r')
// 注意：不能拿「会话强调色」当 picker 已开的信号——命令补全下拉的
// cmd-desc-color 描述（「设置当前会话强调色…」）也含这串字，settle 会
// 秒匹配到 dropdown 导致后续按键错位。色点行「● red」只出现在 picker 里。
check('无参 /color 打开调色板选择器', await settled(() => screenText().includes('● red') && screenText().includes('● blue'), { timeoutMs: 10000 }))
check('选择器聚焦当前色（reset 后无当前色 → 首行 red）', await settled(() => /❯[^\n]*● red/u.test(screenText())), screenText().split('\n').find(l => l.includes('●')) ?? '')
stdin.write('\x1b[B') // ↓：red → orange
check('方向键移动焦点到 orange', await settled(() => /❯[^\n]*● orange/u.test(screenText()), { timeoutMs: 10000 }))
// 固定窗:墙钟 等 Chat 模态 Enter 的 80ms 去重窗口（lastModalEnterAtRef）过期。
// Chat 对模态 Enter 有 80ms 去重（lastModalEnterAtRef，防 \r\n 双事件）：
// 本 harness 处理快时，打开 picker 的 Enter 与应用 Enter 落在同一窗口内，
// 第二个 \r 会被吞掉（Esc 不受影响，实测 picker 活着但不应用）。留出
// 处理时间间隙，与 verify-thinking-display 的 120ms sleep 同一理由。
await sleep(200)
stdin.write('\r')
// 生效上屏是强于下方断言的门（屏上可见 ⇒ mock 已记录），并为后续按键
// pacing——保留 settle。
await settle(() => screenText().includes('会话颜色已设为 orange'), { timeoutMs: 10000 })
check('选择器 Enter 应用 orange', channel.setColorCalls.at(-1) === 'orange', JSON.stringify(channel.setColorCalls))
check('选择器应用后关闭', await settled(() => !screenText().includes('● red') && !screenText().includes('● orange')))
check('选择器设置后边框重绘为橙色 #F76B15', await settled(() => borderFgColor() === 0xf76b15), `0x${borderFgColor()?.toString(16) ?? '?'}`)

// ── 6. /recap 面板：摘要 + 建议标题 + 一键应用 ─────────────────────────
stdin.write('/recap')
await settle(() => screenText().includes('❯ /recap'))
stdin.write('\r')
check('recap 摘要渲染', await settled(() => screenText().includes('最近在修会话颜色与 recap')))
check('建议标题渲染', await settled(() => screenText().includes(RECAP_TITLE_ROW)))
check('应用按钮渲染', await settled(() => screenText().includes('[应用]')))

stdin.write('a')
check('按 a 应用标题走 renameSession', await settled(() => channel.renameCalls[0] === '会话标识 PR'), JSON.stringify(channel.renameCalls))
check('会话标题已更新', channel.sessionTitle === '会话标识 PR', channel.sessionTitle)
check('面板标记已应用', await settled(() => screenText().includes('已应用')))

stdin.write('\x1b')
check('Esc 关闭 recap 面板', await settled(() => {
  const text = screenText()
  return !text.includes(RECAP_TITLE_ROW) && !text.includes('最近在修会话颜色与 recap')
}))
check('关闭面板不要求同文案提示消失', await settled(() => screenText().includes(RECAP_TIP)))

await instance.unmount()
setLang('zh')
process.exit(failures === 0 ? 0 : 1)
