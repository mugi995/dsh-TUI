/**
 * 悬停浮层第二批回归：「浮层只给屏幕上看不到、悬停马上想知道的信息」
 * 在另外三处的落地——
 *
 *  F. @ 文件补全面板：名称列固定 20 列 + 行宽截断，悬停被截断的长路径行
 *     弹出完整路径 + 类型；完整可见的短路径行不弹。
 *  G. 会话列表行：标题截断时悬停弹【完整标题 + 绝对时间 + cwd】；标题
 *     未截断时浮层不重复标题（只带时间 + cwd）。
 *  H. 状态栏 git 字段：悬停 git 弹完整分支名（原地明细行契约，与
 *     tps/cost 同款）。model/effort 已移到输入框上边框（无 hover 明细）。
 *  I. 上下文进度条：条上不再有任何文字（内容类型只由颜色表达，唯一的
 *     文本是最右占比）；整条一个悬停目标，悬停任意位置弹【全部内容类型
 *     + free】的色块+数字明细——条没有标签，这行就是它的 legend。
 *
 * Run: `node --import tsx/esm scripts/verify-hover-details.tsx`
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'verify-hover-details-data-'))
process.env.HOME = dataDir
process.env.USERPROFILE = dataDir
process.env.DSH_TUI_LANG = 'zh'
// 组 I 断言条上各段的底色（进度条去掉标签后，颜色是唯一表达），必须开色。
process.env.FORCE_COLOR = '3'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, ui, tooltip, termTest, metrics] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/Tooltip.js'),
  import('./lib/term-test.mjs'),
  import('../src/screens/StatusMetrics.js'),
])

const { sleep, settled, screenHas, findText, viewportLines } = termTest
const { render, AlternateScreen, Box } = ui

let failed = 0
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed++
}

function KeySink(): React.ReactNode {
  ui.useInput(() => {})
  return null
}

function makeRig(cols: number, rows: number) {
  const term = new XTerm({ cols, rows, scrollback: 50, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
  }
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode() { return this }
    ref() { return this }
    unref() { return this }
  }
  return { term, stdout: new FakeStdout(), stdin: new FakeStdin() }
}

/** SGR mode-1003 motion with no buttons → dispatchHover. Coords 1-indexed. */
const hover = (stdin: PassThrough, col: number, row: number) =>
  stdin.write(`\x1b[<35;${col};${row}M`)

function hoverText(stdin: PassThrough, term: XTerm, needle: string): void {
  const at = findText(term, needle)
  if (at === null) throw new Error(`hover target not found: ${needle}`)
  hover(stdin, at.col + 1, at.row + 1)
}

const { FileSuggestions } = await import('../src/components/FileSuggestions.js')
const { SessionListRow } = await import('../src/components/sessions/SessionListRow.js')
const { StatusLine } = await import('../src/screens/StatusLine.js')
const { formatAbsolute } = await import('../src/sessions/format.js')
const { formatTokens } = await import('../src/terminal-utils/format.js')

try {
  const COLS = 50
  const ROWS = 30
  const rig = makeRig(COLS, ROWS)
  const { term, stdin } = rig

  // --- F. @ 文件补全面板：长路径截断 → 悬停弹全路径 ----------------------
  // 路径宽 43：行内截断（5+43 > usable=46 边界内）且浮层单行放得下
  // （内宽 44），屏幕断言与浮层内容一一对应。
  const LONG_PATH = 'src/components/messages/DeepLongFileName.tsx'
  const files = [
    { id: 'f1', path: LONG_PATH, displayPath: LONG_PATH, name: 'DeepLongFileName.tsx', kind: 'file' as const, score: 1 },
    { id: 'f2', path: 'README.md', displayPath: 'README.md', name: 'README.md', kind: 'file' as const, score: 1 },
  ]
  const instance = await render(
    <AlternateScreen>
      <Box flexDirection="column">
        <KeySink />
        <FileSuggestions files={files} selectedIndex={0} columns={COLS} />
        <tooltip.TooltipLayer />
      </Box>
    </AlternateScreen>,
    { stdout: rig.stdout, stdin: rig.stdin, exitOnCtrlC: false, patchConsole: false },
  )
  await sleep(600) // 固定窗:pacing 等首帧上屏，无单一可轮询锚点
  check('场景 F 就绪：长路径行已截断（尾段不在屏）', await settled(() => !screenHas(term, 'DeepLongFileName.tsx')))
  hoverText(stdin, term, 'src/components/messages')
  check('F 截断路径悬停后弹出完整路径', await settled(() => screenHas(term, 'DeepLongFileName.tsx')))
  // 浮层盖住下方行：先移开再找短路径行的悬停目标。
  hover(stdin, 1, 1)
  check('F 移开后长路径浮层消失', await settled(() => !screenHas(term, 'DeepLongFileName.tsx')))
  // 短路径行：名字完整可见 → 悬停不弹浮层（直查 tooltip store，排除
  // 「卡片内容恰好与可见文本同字」的歧义）。
  hoverText(stdin, term, 'README.md')
  await sleep(900) // 固定窗:探针 完整可见路径不得弹浮层；条件本就成立，轮询立即返回等于没测
  check('F 完整可见路径悬停不弹浮层', tooltip.getTooltipSnapshot() === null,
    `snapshot=${JSON.stringify(tooltip.getTooltipSnapshot()?.content ?? null)}`)

  // --- G. 会话列表行：标题截断 → 悬停弹完整标题+绝对时间+cwd ------------
  const NOW = Date.now()
  const session = {
    id: 'sess-1',
    kind: { kind: 'root' as const },
    title: { text: '修复一个非常长非常长需要被截断才能看到结尾标记END-OF-TITLE的标题', source: 'auto' as const },
    cwd: 'D:\\work\\dsh-tui',
    createdAt: NOW - 86_400_000,
    updatedAt: NOW - 3_600_000,
    bytes: 2048,
    hasPrompt: true,
    agentPreset: undefined,
    model: 'deepseek-chat',
    label: undefined,
    branch: 'main',
    childCount: 0,
  }
  const sessionTree = (width: number) => (
    <AlternateScreen>
      <Box flexDirection="column">
        <KeySink />
        <SessionListRow session={session} width={width} depth={0} focused={false} pinned={false} now={NOW} />
        <tooltip.TooltipLayer />
      </Box>
    </AlternateScreen>
  )
  instance.rerender(sessionTree(60))
  // 负值就绪探针会立即在旧帧上返回（term-test 的系统性坑）：先用正值
  // 等新树真正上屏，再断言截断。
  check('场景 G 就绪：会话行已渲染', await settled(() => screenHas(term, '修复')))
  check('场景 G 就绪：长标题已截断（结尾标记不在屏）', !screenHas(term, 'END-OF-TITLE'))
  hoverText(stdin, term, '修复')
  check('G 截断标题悬停后弹出完整标题', await settled(() => screenHas(term, 'END-OF-TITLE')))
  const absolute = formatAbsolute(session.updatedAt)
  check('G 浮层带绝对时间戳', await settled(() => screenHas(term, absolute)), `abs=${absolute}`)
  check('G 浮层带 cwd', await settled(() => screenHas(term, 'D:\\work\\dsh-tui')))
  hover(stdin, 1, 1)
  check('G 移开即隐藏工具提示', await settled(() => !screenHas(term, 'END-OF-TITLE')))

  // G2：标题完整可见（宽行）→ 浮层不重复标题，只带时间 + cwd。
  instance.rerender(sessionTree(120))
  check('场景 G2 就绪：宽行标题完整在屏', await settled(() => screenHas(term, 'END-OF-TITLE')))
  hoverText(stdin, term, '修复')
  check('G2 完整标题悬停弹浮层（时间+cwd）', await settled(() => tooltip.getTooltipSnapshot() !== null))
  {
    const content = tooltip.getTooltipSnapshot()?.content ?? ''
    check('G2 浮层不重复完整标题', !content.includes('END-OF-TITLE'), `content=${JSON.stringify(content)}`)
    check('G2 浮层仍带绝对时间与 cwd', content.includes(absolute) && content.includes('dsh-tui'))
  }
  hover(stdin, 1, 1)

  // --- H. 状态栏字段：git 悬停明细 ---------------------------------------
  const channelStub = {
    minimalUi: false,
    statusBar: { gitBranch: true },
    provider: 'test-provider',
    contextWindow: 64_000,
    gitBranch: 'test-branch-long',
    displayCwd: 'D:\\work\\dsh-tui',
    cwd: 'D:\\work\\dsh-tui',
    mode: { plan: false, sandbox: 'workspace-write', approval: 'on-request' },
    modeIndex: 0,
    tokens: { input: 0, output: 0 },
    tpsSamples: [],
    backgroundJobs: [],
    contextSegments: {},
    working: false,
    activityFrames: [],
    goal: undefined,
    sessionTitle: undefined,
    agentId: 'abcdef0123456789',
    reasoningEffort: undefined,
    tps: undefined,
    lastUsage: undefined,
    contextBarEnabled: false,
  }
  instance.rerender(
    <AlternateScreen>
      <Box flexDirection="column">
        <KeySink />
        <StatusLine channel={channelStub as never} />
        <tooltip.TooltipLayer />
      </Box>
    </AlternateScreen>,
  )
  check('场景 H 就绪：状态栏 git 字段在屏',
    await settled(() => screenHas(term, 'test-branch-long')))
  check('H 未悬停时无明细行', !screenHas(term, 'git test-branch-long'))
  hoverText(stdin, term, 'test-branch-long')
  check('H 悬停 git 字段弹完整分支明细',
    await settled(() => screenHas(term, 'git test-branch-long')))
  hover(stdin, 1, 1)

  // --- I. 上下文进度条：无标签 + 整条悬停给全量明细 ----------------------
  // I0：纯函数层。ANSI 路径是 ContextBarView 的字符串孪生（同一套列分配与
  // 读出阶梯），先在这里钉死「条上没有类型名」、读出阶梯、压力分档与明细的
  // 宽度阶梯。
  const SEGMENTS = { system: 1200, prompt: 300, assistant: 4000, thinking: 5000, tools: 2000 }
  const USED = 12_500 // input 12000 + cacheRead 500
  {
    const plain = metrics.renderContextBar(SEGMENTS, USED, 64_000, 60).replace(/\x1b\[[0-9;]*m/g, '')
    check('I0 条上无任何文字：去 ANSI 只剩空格',
      plain.trim() === '', `plain=${JSON.stringify(plain)}`)
    const ansi = metrics.renderContextBar(SEGMENTS, USED, 64_000, 60)
    check('I0 条仍按内容类型着色', ansi.includes('48;2;34;48;95m') && ansi.includes('48;2;90;124;255m'),
      'system/tools fills present')
    check('I0 读数阶梯：先给总数+占比，窄了只剩占比',
      metrics.contextBarReadout(USED, 64_000).join(' | ') === '13k/64k 19.5% | 19.5%',
      JSON.stringify(metrics.contextBarReadout(USED, 64_000)))
    // 压力分档与 ctx 悬停量表同阈值（amber ≥ 80 / red ≥ 95）。
    check('I0 压力分档 80/95 与 ctx 量表一致',
      metrics.contextPressureStep(79.9) === undefined
      && metrics.contextPressureStep(80) === 'warning'
      && metrics.contextPressureStep(94.9) === 'warning'
      && metrics.contextPressureStep(95) === 'error',
      [79.9, 80, 94.9, 95].map(p => `${p}:${metrics.contextPressureStep(p) ?? 'none'}`).join(' '))
    const wide = metrics.contextBarBreakdown(SEGMENTS, USED, 64_000, 120)
    check('I0 宽终端明细用可读名 + 圆点分隔',
      wide.entries.map(e => e.label).join(wide.separator)
        === 'system 1.2k · prompt 300 · assistant 4.0k · thinking 5.0k · tools 2.0k · free 52k',
      `got=${JSON.stringify(wide.entries.map(e => e.label).join(wide.separator))}`)
    const narrow = metrics.contextBarBreakdown(SEGMENTS, USED, 64_000, 50)
    check('I0 窄终端明细退化到短名（仍逐项给数）',
      narrow.entries.map(e => e.label).join(narrow.separator)
        === 'sys 1.2k pr 300 ast 4.0k th 5.0k tl 2.0k free 52k',
      `got=${JSON.stringify(narrow.entries.map(e => e.label).join(narrow.separator))}`)
    const empty = metrics.contextBarBreakdown(
      { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 }, 0, 64_000, 120)
    check('I0 零占用段不进明细（与条上不给列数一致）',
      empty.entries.length === 1 && empty.entries[0]?.label === 'free 64k',
      `got=${JSON.stringify(empty.entries.map(e => e.label))}`)
    check('I0 明细色块用各段填充色（颜色↔名字的对应关系）',
      wide.entries[0]?.color === '#22305F' && wide.entries[3]?.color === '#4D6BFE',
      JSON.stringify(wide.entries.map(e => e.color)))
  }

  // I：真机渲染 + 鼠标。120 列让宽终端阶梯成立（可读名），12 行够放下
  // 条+状态行+明细行。
  //
  // 先卸载 F～H 的实例再起第二个：同进程里两个 AlternateScreen 实例并存
  // 时，后者的首帧会漏掉条那行（实测可复现，与本改动无关；卸载先行即可
  // 稳定）。
  instance.unmount()
  await sleep(150) // 固定窗:pacing 等第一个实例完全卸载，第二个实例首帧才完整
  const barRig = makeRig(120, 12)
  const barStub = {
    ...channelStub,
    contextBarEnabled: true,
    contextSegments: SEGMENTS,
    lastUsage: { input: 12_000, output: 0, cacheRead: 500, cacheWrite: 0 },
  }
  const barInstance = await render(
    <AlternateScreen>
      <Box flexDirection="column">
        <KeySink />
        <StatusLine channel={barStub as never} />
        <tooltip.TooltipLayer />
      </Box>
    </AlternateScreen>,
    { stdout: barRig.stdout, stdin: barRig.stdin, exitOnCtrlC: false, patchConsole: false },
  )
  const barTerm = barRig.term
  const barStdin = barRig.stdin
  check('场景 I 就绪：ctx 读数在屏', await settled(() => screenHas(barTerm, '19.5%')))
  {
    // The ctx readout moved to its own row under the bar; the bar row itself
    // carries no text at all now.
    const ctxRow = findText(barTerm, '19.5%')?.row ?? -1
    const barRow = ctxRow - 1
    const line = (barRow < 0 ? '' : barTerm.buffer.active.getLine(barRow)?.translateToString(true) ?? '')
    check('I 条行没有任何文字（读数在下一行）',
      line.trim() === '', `line=${JSON.stringify(line)}`)
    // 各段仍是纯色填充：无子节点的 Box 只靠自己的底色铺满（去掉标签后唯一
    // 的表达方式），底色不画就等于整条消失。
    const bgAt = (x: number): number =>
      (barTerm.buffer.active.getLine(barRow)?.getCell(x)?.getBgColor() ?? 0) & 0xffffff
    check('I 内容类型段仍是实色块（空 Box 由底色铺满）', bgAt(1) === 0x22305f,
      `system bg=${bgAt(1).toString(16)}`)
    check('I free 段铺到条尾', [0x2e3440, 0xe8e8e8].includes(bgAt(116)),
      `free bg=${bgAt(116).toString(16)}`)
  }
  // 悬停条本身（整条一个目标；条上不再有可命中的文字，用坐标）。
  const barY = (findText(barTerm, '19.5%')?.row ?? 1) - 1
  hover(barStdin, 2, barY + 1)
  check('I 悬停条尾弹全量明细（含 system 与 thinking）',
    await settled(() => screenHas(barTerm, 'system 1.2k') && screenHas(barTerm, 'thinking 5.0k')))
  check('I 明细同一行带 free 项', screenHas(barTerm, 'free 52k'))
  {
    // 色块是这一行的全部意义：数字前的 1 格底必须就是该段在条上的填充色，
    // 否则「哪个颜色是哪类」无从对应。
    const chipBg = (needle: string): number => {
      const at = findText(barTerm, needle)
      if (at === null || at.col === 0) return 0
      return (barTerm.buffer.active.getLine(at.row)?.getCell(at.col - 1)?.getBgColor() ?? 0) & 0xffffff
    }
    check('I 明细色块 = 条上该段填充色（system/thinking）',
      chipBg('system 1.2k') === 0x22305f && chipBg('thinking 5.0k') === 0x4d6bfe,
      `system=${chipBg('system 1.2k').toString(16)} thinking=${chipBg('thinking 5.0k').toString(16)}`)
    check('I free 明细色块 = 条上 free 段填充色（暗色主题覆盖）', chipBg('free 52k') === 0x2e3440,
      `free=${chipBg('free 52k').toString(16)}`)
  }
  // 悬停条首（system 段）：仍是同一条全量明细 —— 整条一个悬停目标，明细
  // 不随段落切换而变化（逐段明细是这次去掉的旧行为）。
  {
    hover(barStdin, 2, barY + 1)
    check('I 悬停条首同样是全量明细（整条一个目标）',
      await settled(() => screenHas(barTerm, 'tools 2.0k') && screenHas(barTerm, 'free 52k')))
  }
  hover(barStdin, 1, 1)
  check('I 移开条即撤下明细', await settled(() => !screenHas(barTerm, 'thinking 5.0k')))

  // I2：只知占用、不知构成时，两处悬停都报实测已用量，不列五个 0。
  // 分别覆盖 meter 构成全零，以及旧 meter 缺席且本地估算为空。
  for (const sample of [
    { name: 'ZERO-METER', contextSegments: SEGMENTS, contextBreakdown: { systemTokens: 0, toolsTokens: 0, messageTokens: 0 } },
    { name: 'NO-METER', contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 }, contextBreakdown: undefined },
  ]) {
    barInstance.rerender(
      <AlternateScreen>
        <Box flexDirection="column">
          <KeySink />
          <StatusLine
            channel={{
              ...barStub,
              ...sample,
              statusBar: { contextBar: true, contextUsage: true, cache: false },
            } as never}
          />
          <tooltip.TooltipLayer />
        </Box>
      </AlternateScreen>,
    )
    check(`I2 ${sample.name} 已上屏`, await settled(() => screenHas(barTerm, '19.5%')))
    const i2BarY = (findText(barTerm, '19.5%')?.row ?? 1) - 1
    hover(barStdin, 2, i2BarY + 1)
    check(`I2 ${sample.name} 条悬停沿用已用量兜底`, await settled(() => screenHas(barTerm, '已用 13k')))
    hover(barStdin, 1, 1)
  }

  const { ThemeProvider } = ui
  // I3. statusBar.contextBarStyle='blocks'：单色 █/░ 字符计量条（原始 TUI
  // 外观）。条上没有任何背景填充；悬停图例保留名称+数字但去掉色块（单色条
  // 上没有颜色可供色块对应）。
  barInstance.rerender(
    <AlternateScreen>
      <Box flexDirection="column">
        <KeySink />
        <ThemeProvider theme="dark">
          <StatusLine
            channel={{
              ...barStub,
              lastUsage: { input: 16_000, output: 0, cacheRead: 0, cacheWrite: 0 },
              statusBar: { contextBar: true, contextBarStyle: 'blocks' },
            } as never}
          />
        </ThemeProvider>
        <tooltip.TooltipLayer />
      </Box>
    </AlternateScreen>,
  )
  check('I3 blocks 模式就绪', await settled(() => screenHas(barTerm, '25.0%')))
  {
    const ctxY = findText(barTerm, '25.0%')?.row ?? -1
    const y = ctxY - 1
    const line = y < 0 ? '' : barTerm.buffer.active.getLine(y)?.translateToString(true) ?? ''
    check('I3 条是纯 █/░ 字符计量条（无读数文字）',
      /^█+░+$/.test(line.slice(1)), JSON.stringify(line))
    let background = false
    for (let x = 0; x < barTerm.cols; x++) {
      const cell = barTerm.buffer.active.getLine(y)?.getCell(x)
      if (cell !== undefined && !cell.isBgDefault()) background = true
    }
    check('I3 条行没有背景色块', !background)
    const fg = ((barTerm.buffer.active.getLine(y)?.getCell(1)?.getFgColor() ?? 0) & 0xffffff)
    check('I3 单色：█ 用 inactiveShimmer', fg === 0xaab2c2, `fg=${fg.toString(16)}`)
  }
  const bar25Row = (findText(barTerm, '25.0%')?.row ?? 1) - 1
  hover(barStdin, 2, bar25Row + 1)
  check('I3 悬停仍给全量明细',
    await settled(() => screenHas(barTerm, 'system 1.5k') && screenHas(barTerm, 'free 48k')),
    JSON.stringify(viewportLines(barTerm).filter(line => line !== '')))
  {
    const at = findText(barTerm, 'system 1.5k')
    const before = at === null ? undefined : barTerm.buffer.active.getLine(at.row)?.getCell(at.col - 1)
    check('I3 单色条图例不带色块', before?.isBgDefault() === true)
  }
  hover(barStdin, 1, 1)
  barInstance.unmount()
  await sleep(100) // 固定窗:pacing unmount 收尾输出 flush，无可观测完成条件

  // --- K. 底栏权限模式段：后端原生权限模式（Claude 等）------------------
  // 契约（Chat 侧装配 backendMode 后）：
  //   · 存在 → 该段恒显示（不再看 modeMarked/基础模式）、文本＝后端给的
  //     可读名、点击＝onOpen；颜色只由后端 id 决定——bypassPermissions/
  //     dontAsk → warning，plan → planMode，其余 → inactiveShimmer（DSH
  //     的 plan/marked 规则一概不参与）。
  //   · 缺席 → DSH 语义逐字节不变：下表的金标准是**改动前**的 src 渲染结果
  //     （字符 + 逐格前景色/背景色），钉住「DSH 会话渲染零变化」。
  // 交互面（悬停详情、点击）在同一个 rig 上按后端模式验收。
  const K_COLS = 60
  const K_ROWS = 12
  /** 空行签名：金标准只钉状态行那一行，其余行必须仍是这张白纸。 */
  const K_BLANK_SIG = '60@ffffff/ffffff'
  const K_STUB = {
    minimalUi: false,
    statusBar: { mode: true },
    provider: 'test-provider',
    contextWindow: 64_000,
    gitBranch: 'main',
    displayCwd: 'D:\\work\\dsh-tui',
    cwd: 'D:\\work\\dsh-tui',
    mode: { id: 'default', plan: false, sandbox: 'workspace-write', approval: 'ask' },
    modeIndex: 0,
    tokens: { input: 0, output: 0 },
    tpsSamples: [],
    backgroundJobs: [],
    contextSegments: {},
    working: false,
    activityFrames: [],
    goal: undefined,
    sessionTitle: undefined,
    agentId: 'abcdef0123456789',
    reasoningEffort: undefined,
    tps: undefined,
    lastUsage: undefined,
    contextBarEnabled: false,
  }
  type ModeSegment = { readonly id: string, readonly name: string, readonly onOpen: () => void }
  const modeScreen = (channel: unknown, backendMode?: ModeSegment) => (
    <AlternateScreen>
      <Box flexDirection="column">
        <KeySink />
        <ui.ThemeProvider theme="dark">
          <StatusLine channel={channel as never} {...(backendMode === undefined ? {} : { backendMode })} />
        </ui.ThemeProvider>
        <tooltip.TooltipLayer />
      </Box>
    </AlternateScreen>
  )
  /** 字符行（去尾空格）+ 每行「等色行程」签名：改了字或改了色都算漂移。 */
  const dumpMode = (term: XTerm) => {
    const lines: string[] = []
    const sigs: string[] = []
    for (let y = 0; y < K_ROWS; y++) {
      const line = term.buffer.active.getLine(y)
      lines.push(line ? line.translateToString(true) : '')
      let sig = ''
      let runColor: string | null = null
      let runLen = 0
      for (let x = 0; x < K_COLS; x++) {
        const cell = line?.getCell(x)
        const colour = ((cell?.getFgColor() ?? 0) & 0xffffff).toString(16)
          + '/' + ((cell?.getBgColor() ?? 0) & 0xffffff).toString(16)
        if (colour === runColor) { runLen++ } else {
          if (runColor !== null) sig += runLen + '@' + runColor + ' '
          runColor = colour
          runLen = 1
        }
      }
      if (runColor !== null) sig += runLen + '@' + runColor
      sigs.push(sig.trim())
    }
    return { lines: lines.filter(l => l !== ''), sigs }
  }
  const fgAt = (term: XTerm, col: number, row: number): number =>
    (term.buffer.active.getLine(row)?.getCell(col)?.getFgColor() ?? 0) & 0xffffff
  /** 后端模式段的颜色断言：等到名字在屏、且它首格前景色就是期望值。 */
  const modeColourSettles = (term: XTerm, name: string, expected: number) =>
    settled(() => {
      const at = findText(term, name)
      return at !== null && fgAt(term, at.col, at.row) === expected
    })

  const openModeRig = async (channel: unknown, backendMode?: ModeSegment) => {
    const rig = makeRig(K_COLS, K_ROWS)
    const instance = await render(modeScreen(channel, backendMode), {
      stdout: rig.stdout, stdin: rig.stdin, exitOnCtrlC: false, patchConsole: false,
    })
    return { rig, instance }
  }

  // K1. 后端模式：基础模式也显示 + 悬停详情 + 点击 + 三种颜色。
  {
    let opened = 0
    const segment = (id: string, name: string): ModeSegment => ({ id, name, onOpen: () => { opened++ } })
    const { rig, instance } = await openModeRig(K_STUB, segment('acceptEdits', '自动接受编辑'))
    const { term, stdin } = rig
    check('K1 后端模式名在屏（DSH 基础模式也会显示）',
      await settled(() => screenHas(term, '自动接受编辑')), 'name=自动接受编辑')
    check('K1 acceptEdits → inactiveShimmer #AAB2C2',
      await modeColourSettles(term, '自动接受编辑', 0xaab2c2),
      'fg=' + fgAt(term, findText(term, '自动接受编辑')?.col ?? 0, findText(term, '自动接受编辑')?.row ?? 0).toString(16))
    hoverText(stdin, term, '自动接受编辑')
    check('K1 悬停详情用后端模式名 + 既有 affordance 文案',
      await settled(() => screenHas(term, 'mode 自动接受编辑 · 点击或 /permission 切换权限模式')))
    hover(stdin, 1, 1)
    check('K1 移开后详情行撤下', await settled(() => !screenHas(term, '切换权限模式')))
    {
      const at = findText(term, '自动接受编辑')
      if (at === null) check('K1 点击目标仍在屏', false)
      else {
        stdin.write('\x1b[<0;' + (at.col + 1) + ';' + (at.row + 1) + 'M')
        stdin.write('\x1b[<0;' + (at.col + 1) + ';' + (at.row + 1) + 'm')
      }
      check('K1 点击模式段调用 onOpen', await settled(() => opened === 1), 'opened=' + opened)
    }
    instance.rerender(modeScreen(K_STUB, segment('bypassPermissions', '跳过权限')))
    check('K1 bypassPermissions → warning #D8B270',
      await modeColourSettles(term, '跳过权限', 0xd8b270))
    instance.rerender(modeScreen(K_STUB, segment('dontAsk', '不询问')))
    check('K1 dontAsk → warning #D8B270', await modeColourSettles(term, '不询问', 0xd8b270))
    instance.rerender(modeScreen(K_STUB, segment('plan', '计划模式')))
    check('K1 后端 plan → planMode #7FAE99', await modeColourSettles(term, '计划模式', 0x7fae99))
    // DSH 自身的 plan 标记不得泄进后端模式的颜色：id 不认识就是 inactiveShimmer。
    instance.rerender(modeScreen(
      { ...K_STUB, mode: { id: 'plan', plan: true, sandbox: 'read-only', approval: 'ask' } },
      segment('default', '默认'),
    ))
    check('K1 DSH 标记不泄漏进后端模式颜色（default → inactiveShimmer）',
      await modeColourSettles(term, '默认', 0xaab2c2))
    instance.unmount()
    await sleep(150) // 固定窗:pacing 换实例前等上一个卸载收尾
  }

  // K2. 缺席（DSH 会话）：底栏逐字节等于当前契约。model/effort/cwd 已移到
  // 输入框上边框；底栏第一行是 ctx/cache 读数，模式段在第二行（标记时）。
  const K_CTX_LINE = ' ctx --/-- 0% cache 0%'
  const K_CTX_SIG = '1@ffffff/ffffff 4@8d95a6/ffffff 9@aab2c2/ffffff 6@8d95a6/ffffff 2@aab2c2/ffffff 38@ffffff/ffffff'
  const DSH_GOLDEN = [
    {
      key: '基础模式（不显示 mode 段）',
      channel: { ...K_STUB, modeIndex: 0 },
      line: K_CTX_LINE,
      sig: K_CTX_SIG,
    },
    {
      key: '标记模式（Shift+Tab 到第 2 档）',
      channel: { ...K_STUB, modeIndex: 1 },
      line: K_CTX_LINE + '\n 默认',
      sig: K_CTX_SIG,
    },
    {
      key: '计划模式',
      channel: { ...K_STUB, mode: { id: 'plan', plan: true, sandbox: 'read-only', approval: 'ask' } },
      line: K_CTX_LINE + '\n 计划模式',
      sig: K_CTX_SIG,
    },
    {
      key: '完全访问（danger-full-access + approval never）',
      channel: { ...K_STUB, mode: { id: 'full', plan: false, sandbox: 'danger-full-access', approval: 'never' } },
      line: K_CTX_LINE + '\n 完全访问',
      sig: K_CTX_SIG,
    },
  ]
  for (const golden of DSH_GOLDEN) {
    const { rig, instance } = await openModeRig(golden.channel)
    const { term } = rig
    check('K2 就绪：' + golden.key, await settled(() => screenHas(term, 'cache 0%')))
    await sleep(250) // 固定窗:探针 末帧落定：金标准比对的是「整行字节」，不能比对半帧
    const dump = dumpMode(term)
    check('K2 ' + golden.key + ' 字符行逐字节不变',
      dump.lines.join('\n') === golden.line, 'got=' + JSON.stringify(dump.lines))
    check('K2 ' + golden.key + ' 状态行配色逐格不变',
      dump.sigs[0] === golden.sig, 'got=' + JSON.stringify(dump.sigs[0]))
    check('K2 ' + golden.key + ' 其余行仍是空屏',
      dump.sigs.slice(golden.line.split('\n').length).every(s => s === K_BLANK_SIG))
    instance.unmount()
    await sleep(120) // 固定窗:pacing 换实例前等上一个卸载收尾
  }



  // K3. 优先级：安全读数压过字段开关，但压不过极简界面。
  {
    const seg: ModeSegment = { id: 'acceptEdits', name: '自动接受编辑', onOpen: () => undefined }
    // (a) statusBar.mode=false + backendMode → 段仍然显示（安全读数压过字段开关）。
    {
      const { rig, instance } = await openModeRig({ ...K_STUB, statusBar: { mode: false } }, seg)
      check('K3a statusBar.mode=false 时后端模式段仍显示',
        await settled(() => screenHas(rig.term, '自动接受编辑')), rig.term.buffer.active.getLine(0)?.translateToString(true) ?? '')
      instance.unmount()
      await sleep(120) // 固定窗:pacing 换实例前等上一个卸载收尾
    }
    // (b) minimalUi=true + backendMode → 段不显示：极简界面是用户显式选的
    // 「只要目录」，不能被安全读数顶掉；模型读数改由输入框上边框承载（不在
    // 本脚本挂载的 StatusLine 里）。
    {
      const { rig, instance } = await openModeRig({ ...K_STUB, minimalUi: true }, seg)
      check('K3b minimalUi 就绪', await settled(() => screenHas(rig.term, 'cache 0%')))
      await sleep(250) // 固定窗:探针 末帧落定：金标准比对的是「整行字节」，不能比对半帧
      const dump = dumpMode(rig.term)
      check('K3b minimalUi：底栏只剩 ctx/cache 行（模式段不显示）',
        dump.lines.join('\n') === K_CTX_LINE, 'got=' + JSON.stringify(dump.lines))
      check('K3b minimalUi：屏上无后端模式名', !dump.lines.join('\n').includes('自动接受编辑'))
      instance.unmount()
      await sleep(120) // 固定窗:pacing 换实例前等上一个卸载收尾
    }
    // (c) DSH（backendMode 缺席）+ statusBar.mode=false → 与改动前逐字节
    // 一致：标记模式照样藏起，行内容等于基础模式金标准。
    {
      const { rig, instance } = await openModeRig({ ...K_STUB, statusBar: { mode: false }, modeIndex: 1 })
      check('K3c DSH mode:false 就绪', await settled(() => screenHas(rig.term, 'cache 0%')))
      await sleep(250) // 固定窗:探针 末帧落定：金标准比对的是「整行字节」，不能比对半帧
      const dump = dumpMode(rig.term)
      check('K3c DSH 关掉字段开关时标记模式不显示（逐字节同基础模式）',
        dump.lines.join('\n') === K_CTX_LINE, 'got=' + JSON.stringify(dump.lines))
      check('K3c 状态行配色逐格不变',
        dump.sigs[0] === DSH_GOLDEN[0].sig, 'got=' + JSON.stringify(dump.sigs[0]))
      check('K3c 其余行仍是空屏', dump.sigs.slice(1).every(s => s === K_BLANK_SIG))
      instance.unmount()
      await sleep(120) // 固定窗:pacing 换实例前等上一个卸载收尾
    }
  }

  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILURES`)
  process.exit(failed === 0 ? 0 : 1)
} catch (err) {
  console.error(err)
  process.exit(1)
}
