import React from 'react'
import { Box, Text, useTheme } from '../ui.js'
import type { Color } from '../ink/styles.js'
import { getTheme } from '../theme.js'
import {
  FREE_SEGMENT_FILL,
  USED_SEGMENTS,
  usedSegmentColor,
  barSegments,
  contextBarColumns,
  contextBarSegmentColors,
  contextBarUsedColor,
  type ContextSegments,
} from '../screens/StatusMetrics.js'
import type { ContextBreakdown } from '../adapter/ports/channel-view.js'

/**
 * The hoverable JSX twin of `renderContextBar`: the same segmented context
 * bar (same largest-remainder column split, same free-segment readout),
 * rendered as one Box per segment so the bar can react to the pointer.
 *
 * A used segment is its fill color and nothing else — no label (community
 * feedback on the old `s`/`p`/`t` letters: they read as noise on a row that is
 * already decorative, and they never fit the narrow segments anyway). The bar
 * carries no text at all now; the ctx/cache readout moved to the line directly
 * under it.
 *
 * ONE hover target for the whole bar rather than one per segment. The colors
 * are named where there is room for words: hovering anywhere on the bar parks
 * the full per-content-type breakdown on the footer's supplemental row. A
 * per-segment target also made every crossing of the five fills an
 * enter+leave pair, hence a footer re-render per crossing.
 *
 * The component path follows the ANSI path's geometry: this exists so the bar
 * can react to the pointer, not to restyle it.
 */
export function ContextBarView({
  segments,
  breakdown,
  usedTokens,
  contextWindow,
  width,
  colors,
  onHover,
}: {
  /** Local token estimates per content type, dividing the filled portion only. */
  segments: ContextSegments
  /** The meter's composition, when the harness publishes one; the estimates
   *  above then only split its message side. */
  breakdown?: ContextBreakdown | undefined
  /** Measured occupancy, driving both fill length and readout. */
  usedTokens: number
  /** The context window size in tokens. */
  contextWindow: number
  /** Total bar width in terminal columns. */
  width: number
  /** Theme overrides for the free segment (light theme passes its own). */
  colors?: { freeFill: Color }
  /** Hover signal: true while the pointer is anywhere on the bar, false on
   *  leave. Absent handlers render a static bar (tests, headless embeds). */
  onHover?: (hovered: boolean) => void
}): React.ReactNode {
  // The five used fills come from the palette (contextBar* keys); only the free
  // segment still takes an override, since its shading is a light/dark call the
  // call site already made.
  const [themeName] = useTheme()
  if (width <= 0 || contextWindow <= 0) return null

  const segmentColors = contextBarSegmentColors(getTheme(themeName))
  // The composition re-weights the fills only: the occupancy still fixes the
  // span, so the fills can never add up to a longer or shorter bar than the
  // readout right of them quotes.
  const columns = contextBarColumns(
    barSegments(segments, breakdown),
    usedTokens,
    contextWindow,
    width,
  )
  const nodes: React.ReactNode[] = []
  for (const [index, segment] of USED_SEGMENTS.entries()) {
    const segmentWidth = columns.used[index] ?? 0
    if (segmentWidth <= 0) continue
    // Childless on purpose: the renderer fills a node's own rect with its
    // backgroundColor, so the segment is a pure colored block (render-node-to-
    // output's ownBackgroundColor fill).
    nodes.push(
      <Box
        key={segment.key}
        width={segmentWidth}
        height={1}
        flexShrink={0}
        backgroundColor={usedSegmentColor({
          key: segment.key,
          color: segmentColors[index] ?? segment.fallback,
        })}
      />,
    )
  }

  if (columns.unclassified > 0) {
    nodes.push(
      <Box
        key="used"
        width={columns.unclassified}
        height={1}
        flexShrink={0}
        backgroundColor={contextBarUsedColor(segmentColors)}
      />,
    )
  }

  const freeWidth = columns.free
  if (freeWidth > 0) {
    nodes.push(
      <Box
        key="free"
        width={freeWidth}
        height={1}
        flexShrink={0}
        backgroundColor={colors?.freeFill ?? FREE_SEGMENT_FILL}
      />,
    )
  }

  return (
    <Box
      flexDirection="row"
      flexShrink={0}
      width={width}
      onMouseEnter={onHover === undefined ? undefined : () => onHover(true)}
      onMouseLeave={onHover === undefined ? undefined : () => onHover(false)}
    >
      {nodes}
    </Box>
  )
}

/**
 * The single-colour counterpart of {@link ContextBarView} (settings
 * `statusBar.contextBarStyle: 'blocks'`): one line of `█` for the used span
 * and `░` for the free span — the original-TUI block gauge, without the five
 * content-type colors (the hover legend still names the composition) and
 * without the in-bar readout (the ctx/cache row below carries it).
 *
 * Geometry mirrors the segmented bar: the used span is the occupancy fraction
 * of the full width, so the right edge keeps its column. The whole line uses
 * one theme colour by design; pressure thresholds and per-segment tints
 * belong to the segmented style only.
 */
export function BlockContextBar({
  usedTokens,
  contextWindow,
  width,
  onHover,
}: {
  /** Measured occupancy, driving both fill length and readout. */
  usedTokens: number
  /** The context window size in tokens. */
  contextWindow: number
  /** Total bar width in terminal columns. */
  width: number
  /** Hover signal: true while the pointer is anywhere on the bar, false on
   *  leave. Absent handlers render a static bar (tests, headless embeds). */
  onHover?: (hovered: boolean) => void
}): React.ReactNode {
  if (width <= 0 || contextWindow <= 0) return null
  const ratio = Math.min(1, Math.max(0, usedTokens / contextWindow))
  const usedWidth = Math.min(width, Math.max(0, Math.round(width * ratio)))
  const freeWidth = width - usedWidth
  return (
    <Box
      flexDirection="row"
      flexShrink={0}
      width={width}
      onMouseEnter={onHover === undefined ? undefined : () => onHover(true)}
      onMouseLeave={onHover === undefined ? undefined : () => onHover(false)}
    >
      <Text color="inactiveShimmer" wrap="truncate">
        {'█'.repeat(usedWidth)}
        {'░'.repeat(freeWidth)}
      </Text>
    </Box>
  )
}
