import React from 'react'
import { Box, Text } from '../ui.js'
import type { QuotaSnapshot } from '../quota/types.js'
import { quotaFooterLines } from '../quota/footer.js'

/**
 * The always-on subscription rows in the right column of the ctx/cache line.
 * Text only (amounts are numbers, usage windows are 10-cell bars); this
 * component is deliberately dumb so the footer stays one column of lines.
 */
export function QuotaFooter({ snapshot }: { snapshot?: QuotaSnapshot }): React.ReactNode {
  const lines = React.useMemo(
    () => snapshot === undefined ? [] : quotaFooterLines(snapshot),
    [snapshot],
  )
  if (lines.length === 0) return null
  return (
    <Box flexDirection="column" flexShrink={0}>
      {lines.map((line, index) => (
        <Text key={index} color="inactiveShimmer" wrap="truncate">{line}</Text>
      ))}
    </Box>
  )
}
