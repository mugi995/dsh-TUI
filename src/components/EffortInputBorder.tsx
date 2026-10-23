/**
 * EffortInputBorder — 输入框层上的三幕点焰叠加（对齐 Codex 的完整
 * 语义：光扫过、档位字样浮现、整体渐隐）。
 *
 * 输入框只有顶/底两条横边框（round、无左右）——本组件自绘这两行，
 * **同步**承载动画；档位字样由输入行尾的 EffortTierBadge 短暂显示
 * （见 PromptInput），动画全程行数恒定。切到最高思考强度档时：
 *
 *   1. 扫光 [0, 1s)——一段高亮彩色光带沿顶/底边框同步自左向右扫过
 *      （wave 波形逐列变色），期间输入框完全正常可用；
 *   2. 档位字样 [600ms, ~1.1s)——光带行至中段时，输入行居中浮现
 *      档名大写（由暗渐亮加粗、间距聚拢，见 EffortTierBadge）；
 *   3. 渐隐 [1.5s, 2s)——字样连同光色一起向主题色淡出，末帧归零：
 *      静止时顶/底边框就是原主题色，内容区无任何附加物。
 *
 * glyph 变化仅限字样行的出现/让位（一次性）；其余帧间变化全部是既
 * 有 `─` 的前景色。触发判定在渲染期做（props-变化-调整模式）；从
 * 「已有档位」切到档位表末位最高档才触发，冷启动恢复偏好/单档表/
 * 无档位表/无共享时钟均不触发。时钟复用 Ink core 共享时钟，仅动画
 * 窗口订阅（keepAlive），播完回到零开销静止边框。
 */
import React, { useContext, useEffect, useReducer, useRef, useState } from 'react'
import { Box, Text, useTheme } from '../ui.js'
import { ClockContext } from '../ink/components/ClockContext.js'
import type { Color } from '../ink/styles.js'
import { stringWidth } from '../ink/stringWidth.js'
import type { Theme } from '../theme.js'
import { IGNITION_TIMELINE, ignitionColors, ignitionLineColors } from '../trajectory/effortIgnition.js'

type Overlay = { label: string; startedAtMs: number }

/** A static chip on the top border row used for the session label. */
export interface InputBorderLabel {
  /** Visible text (already width-truncated by the caller). */
  text: string
  /** Chip background (theme token or raw color). */
  color: keyof Theme | Color
  /** Chip foreground (theme token or raw color). */
  ink: keyof Theme | Color
}

/** A caller-built node embedded in a border row (the model / effort readout).
 *  `width` is its exact display width, so the border runs can be clipped to
 *  exactly the cells left over. */
export interface InputBorderSlot {
  width: number
  node: React.ReactNode
}

/** 边框行（顶/底共用同一色段序列——同步变色）。顶行可在右圆角前插入
 *  一个静态标签 chip（会话名），两端可各插入一个调用方节点（左：模型/
 *  effort 读数；右：cwd）。占用的列数从色段序列里扣掉，行宽不变。 */
function BorderRow({
  left,
  right,
  runs,
  idleColor,
  label,
  leftSlot,
  rightSlot,
}: {
  left: string
  right: string
  runs: ReadonlyArray<{ glyph: string; color: keyof Theme | Color }>
  idleColor: keyof Theme | Color
  label?: InputBorderLabel
  leftSlot?: InputBorderSlot
  rightSlot?: InputBorderSlot
}): React.ReactNode {
  const labelWidth = label === undefined ? 0 : stringWidth(` ${label.text} `)
  // chip 与右圆角之间的留白（边框线格数）：视觉上不让标签贴死 ╮。
  const labelGap = label === undefined ? 0 : 2
  const slotGap = 2
  // 左槽位自带左 1 格、右 2 格的边框线；右槽位在无 chip 时自带左侧 2 格，
  // 有 chip 时由 chip 后的留白充当，右侧只留 1 格——最后一行读数因此比
  // 其它槽位更贴近右圆角（用户指定的「再右一列」）。
  const leftLead = leftSlot === undefined ? 0 : 1
  const leftReserve = leftSlot === undefined ? 0 : leftSlot.width + leftLead + slotGap
  const rightLead = rightSlot !== undefined && label === undefined ? slotGap : 0
  const rightGap = rightSlot === undefined ? 0 : 1
  const rightReserve = rightSlot === undefined ? 0 : rightSlot.width + rightLead + rightGap
  // 裁剪色段序列到剩余列数（每行总宽不变）。
  let budget = Math.max(0, runs.reduce((sum, run) => sum + run.glyph.length, 0) - labelWidth - labelGap - leftReserve - rightReserve)
  const clipped: Array<{ glyph: string; color: keyof Theme | Color }> = []
  for (const run of runs) {
    if (budget <= 0) break
    const take = Math.min(run.glyph.length, budget)
    if (take > 0) clipped.push({ glyph: run.glyph.slice(0, take), color: run.color })
    budget -= take
  }
  return (
    <Box width="100%" height={1} flexShrink={0} overflow="hidden" flexDirection="row">
      <Text color={idleColor}>{left}</Text>
      {leftSlot !== undefined && <Text color={idleColor}>{'─'.repeat(leftLead)}</Text>}
      {leftSlot !== undefined && <Box flexShrink={0}>{leftSlot.node}</Box>}
      {leftSlot !== undefined && <Text color={idleColor}>{'─'.repeat(slotGap)}</Text>}
      {clipped.map((run, i) => (
        <Text key={i} color={run.color}>
          {run.glyph}
        </Text>
      ))}
      {label !== undefined && (
        <Text backgroundColor={label.color} color={label.ink}>{` ${label.text} `}</Text>
      )}
      {label !== undefined && <Text color={idleColor}>{'─'.repeat(labelGap)}</Text>}
      {rightSlot !== undefined && rightLead > 0 && <Text color={idleColor}>{'─'.repeat(rightLead)}</Text>}
      {rightSlot !== undefined && <Box flexShrink={0}>{rightSlot.node}</Box>}
      {rightSlot !== undefined && <Text color={idleColor}>{'─'.repeat(rightGap)}</Text>}
      <Text color={idleColor}>{right}</Text>
    </Box>
  )
}

export function EffortInputBorder({
  effort,
  levels,
  columns,
  idleColor,
  topRightLabel,
  topLeftSlot,
  topRightSlot,
  children,
}: {
  /** 当前思考强度档 id；`undefined` 表示路线未声明。 */
  effort: string | undefined
  /** 当前路线的档位表（低→高，末位为最高档）；未知时传 `undefined`。 */
  levels: readonly string[] | undefined
  columns: number
  /** 静止边框色（主题 token 名，如 'promptBorder' / 'planMode'）。 */
  idleColor: keyof Theme | Color
  /** 顶边框右侧的静态标签 chip（会话名标签）；undefined = 不显示。 */
  topRightLabel?: InputBorderLabel
  /** 顶边框左端的调用方节点（模型/effort 读数）；undefined = 不显示。 */
  topLeftSlot?: InputBorderSlot
  /** 顶边框右端的调用方节点（cwd）；undefined = 不显示。 */
  topRightSlot?: InputBorderSlot
  children: React.ReactNode
}): React.ReactNode {
  const clock = useContext(ClockContext)
  // 扫光色取自当前主题（ignition / ignitionDim），与 ─ 底色的取用方式一致；
  // 缺键的旧主题回落到点火专属的蓝白对。
  const [themeName] = useTheme()
  const [overlay, setOverlay] = useState<Overlay | null>(null)
  const [prevEffort, setPrevEffort] = useState(effort)
  const [, forceRender] = useReducer((tick: number) => tick + 1, 0)

  // 渲染期触发：effort 变化的首帧就以新状态渲染（effect 会晚一帧）。
  if (effort !== prevEffort) {
    setPrevEffort(effort)
    if (
      clock !== null &&
      effort !== undefined &&
      levels !== undefined &&
      levels.length > 1 &&
      effort === levels[levels.length - 1]
    ) {
      setOverlay({ label: effort.toUpperCase(), startedAtMs: clock.now() })
    }
  }

  // 仅动画窗口订阅共享时钟；静止边框零定时器零重渲染。
  const elapsedMs =
    overlay === null ? Infinity : Math.max(0, (clock?.now() ?? Date.now()) - overlay.startedAtMs)
  useEffect(() => {
    if (overlay === null || clock === null) return
    return clock.subscribe(() => forceRender(), /* keepAlive */ true)
  }, [overlay, clock])
  useEffect(() => {
    if (overlay !== null && elapsedMs >= IGNITION_TIMELINE.fadeEndMs) setOverlay(null)
  }, [overlay, elapsedMs])

  const midWidth = Math.max(0, columns - 2)
  const sweepColors =
    overlay !== null && elapsedMs < IGNITION_TIMELINE.sweepMs && midWidth > 0
      ? ignitionLineColors({ elapsedMs, width: midWidth, colors: ignitionColors(themeName) })
      : []
  // 顶/底共用的色段序列（同步）：扫光列取波形色，其余列回主题色。
  const runs: Array<{ glyph: string; color: keyof Theme | Color }> = []
  for (let index = 0; index < midWidth; index++) {
    const color = sweepColors[index] as keyof Theme | Color | undefined ?? idleColor
    const last = runs[runs.length - 1]
    if (last !== undefined && last.color === color) last.glyph += '─'
    else runs.push({ glyph: '─', color })
  }

  return (
    <Box
      flexDirection="column"
      alignItems="flex-start"
      justifyContent="flex-start"
      width="100%"
      flexShrink={0}
    >
      <BorderRow left="╭" right="╮" runs={runs} idleColor={idleColor} label={topRightLabel} leftSlot={topLeftSlot} rightSlot={topRightSlot} />
      <Box flexShrink={0}>{children}</Box>
      <BorderRow left="╰" right="╯" runs={runs} idleColor={idleColor} />
    </Box>
  )
}
