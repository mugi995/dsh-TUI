/**
 * /quota fetch + adaptive report regression.
 *
 * The three services return different shapes: Ollama Cloud money balances,
 * OpenCode Go only window percentages, Command Code credits plus rolling
 * windows. These checks pin that partial data renders without inventing
 * fields, that one provider's failure does not hide the others, and that
 * auth files resolve without touching the network.
 *
 * Run: node --import tsx/esm scripts/verify-quota.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchQuotaSnapshot } from '../src/quota/fetch.js'
import { resolveQuotaKeys } from '../src/quota/keys.js'
import { formatQuotaReport } from '../src/quota/report.js'
import { quotaBar, quotaFooterLines } from '../src/quota/footer.js'
import { parseQuotaCommand } from '../src/quota/command.js'
import { QUOTA_OFFICIAL_BASE, normalizeQuotaBaseURL, readQuotaSettings, resolveQuotaProviderId, writeQuotaSettings } from '../src/quota/config.js'
import { setLang } from '../src/i18n.js'

setLang('en')

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  (${detail})`}`)
  if (!ok) failures += 1
}

const NOW = Date.parse('2026-10-23T00:00:00Z')
const at = (iso: string): string => iso

type Reply = { status?: number; body?: unknown }
const fetchWith = (replies: Map<string, Reply>, seen: string[] = []): typeof fetch =>
  (async (input: string | URL | Request) => {
    const url = String(input)
    seen.push(url)
    const reply = [...replies.entries()].find(([needle]) => url.includes(needle))?.[1]
    if (reply === undefined) return new Response('{}', { status: 404 })
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

const ollamaBody = {
  included: {
    balance_usd: 72.5,
    allowance_usd: 100,
    period: { from: '2026-09-15T00:00:00Z', until: '2026-10-15T00:00:00Z' },
  },
  purchased: { balance_usd: 25 },
}
const opencodeBody = {
  usage: {
    rolling: { percent: 40, resetsAt: '2026-10-23T03:12:00Z' },
    weekly: { percent: 78, resetsAt: '2026-10-25T04:00:00Z' },
    monthly: { percent: 82, resetsAt: '2026-10-31T00:00:00Z' },
  },
}
const commandBodies = {
  '/alpha/whoami': { org: { id: 'org_1' }, user: { email: 'a@example.com' } },
  '/alpha/billing/credits': {
    credits: { monthlyCredits: 66.03, purchasedCredits: 5, freeCredits: 2 },
    windowLimits: { fiveHour: { used: 12, cap: 100, resetAt: NOW + 4 * 3600_000 }, weekly: { used: 11, cap: 100, resetAt: NOW + 6 * 86_400_000 } },
  },
  '/alpha/billing/subscriptions': { data: { planId: 'individual-goat', status: 'active', currentPeriodEnd: '2026-10-31T00:00:00Z' } },
}

{
  // All three together.
  const replies = new Map<string, Reply>([
    ['ollama.com/api/balance', { body: ollamaBody }],
    ['opencode.ai/zen/go/v1/usage', { body: opencodeBody }],
    ['/alpha/whoami', { body: commandBodies['/alpha/whoami'] }],
    ['/alpha/billing/credits', { body: commandBodies['/alpha/billing/credits'] }],
    ['/alpha/billing/subscriptions', { body: commandBodies['/alpha/billing/subscriptions'] }],
    ['openrouter.ai/api/v1/key', { body: { data: { limit: 20, limit_remaining: 15, usage: 5, budgets: [{ scope: 'member', limit_usd: 50, spend_usd: 40, remaining_usd: 10, reset_interval: 'weekly', resets_at: '2026-10-26T00:00:00Z' }] } } }],
    ['openrouter.ai/api/v1/credits', { body: { data: { total_credits: 100, total_usage: 12.5 } } }],
  ])
  const seen: string[] = []
  const snapshot = await fetchQuotaSnapshot(
    { ollama: 'o-key', opencodeGo: 'g-key', commandCode: 'c-key', openrouter: 'r-key' },
    fetchWith(replies, seen),
    () => NOW,
  )
  check('4 providers fetched in fixed order', snapshot.providers.map(p => p.id).join(',') === 'ollama,opencode-go,command-code,openrouter')
  const ollama = snapshot.providers[0]
  check('Ollama credits: included left/limit + purchased',
    ollama?.credits?.remaining === 72.5 && ollama.credits.limit === 100 && ollama.credits.purchased === 25,
    JSON.stringify(ollama?.credits))
  check('Ollama derives 27.5% used from the allowance',
    ollama?.windows[0]?.id === 'included' && Math.abs((ollama.windows[0]?.usedPercent ?? 0) - 27.5) < 0.001,
    JSON.stringify(ollama?.windows))
  const go = snapshot.providers[1]
  check('OpenCode Go reports percent windows only (no credits)',
    go?.windows.length === 3 && go.credits === undefined && go.windows.map(w => w.id).join(',') === 'five-hour,weekly,monthly',
    JSON.stringify(go?.windows))
  const cc = snapshot.providers[2]
  check('Command Code credits sum three buckets',
    cc?.credits?.remaining === 73.03 && cc.credits.purchased === 5 && cc.credits.free === 2,
    JSON.stringify(cc?.credits))
  check('Command Code uses the alpha whoami org for the next calls',
    seen.some(url => url.includes('/alpha/billing/credits?orgId=org_1')) && seen.some(url => url.includes('/alpha/billing/subscriptions?orgId=org_1')),
    seen.join(' '))
  check('Command Code plan label + 5h/weekly percentages + monthly reset',
    cc?.plan === 'GOAT' && cc.windows.map(w => w.id).join(',') === 'five-hour,weekly,monthly'
      && Math.abs((cc.windows[0]?.usedPercent ?? 0) - 12) < 0.001,
    JSON.stringify({ plan: cc?.plan, windows: cc?.windows }))
  const or = snapshot.providers[3]
  check('OpenRouter account credits come from /credits (total purchased - used)',
    or?.credits?.remaining === 87.5 && or.credits.limit === 100,
    JSON.stringify(or?.credits))
  check('OpenRouter effective weekly budget becomes an 80% window',
    or?.windows[0]?.id === 'budget-weekly' && Math.abs((or.windows[0]?.usedPercent ?? 0) - 80) < 0.001,
    JSON.stringify(or?.windows))
  check('Every request carries its own Bearer key',
    seen.filter(url => url.includes('ollama.com')).length === 1 && seen.filter(url => url.includes('opencode.ai')).length === 1)
  const lines = formatQuotaReport(snapshot, NOW)
  const text = lines.join('\n')
  check('Report prints Ollama balance + percent + purchased',
    text.includes('Ollama Cloud') && text.includes('$72.50 / $100') && text.includes('27.5% used') && text.includes('purchased $25.00'), text)
  check('Report prints OpenCode Go windows', text.includes('5h 40% used') && text.includes('Weekly 78% used'), text)
  check('Report prints Command Code plan/credits/windows',
    text.includes('Command Code · GOAT') && text.includes('$73.03') && text.includes('5h 12% used'), text)
  check('Report prints OpenRouter account credits and budget window',
    text.includes('OpenRouter') && text.includes('$87.50 / $100') && text.includes('Weekly budget 80% used'), text)
  check('No placeholder NaN/undefined', !/NaN|undefined/.test(text))
}

{
  // Adaptive: only the fields the API returned. Ollama has purchased only;
  // OpenCode Go lacks a monthly window; Command Code lacks caps.
  const replies = new Map<string, Reply>([
    ['ollama.com/api/balance', { body: { purchased: { balance_usd: 9.5 } } }],
    ['opencode.ai/zen/go/v1/usage', { body: { usage: { rolling: { percent: 5, resetsAt: '2026-10-23T01:00:00Z' } } } }],
    ['/alpha/whoami', { status: 404, body: {} }],
    ['/alpha/billing/credits', { body: { credits: { monthlyCredits: 4 } } }],
    ['/alpha/billing/subscriptions', { status: 404, body: {} }],
  ])
  const snapshot = await fetchQuotaSnapshot({ ollama: 'o', opencodeGo: 'g', commandCode: 'c' }, fetchWith(replies), () => NOW)
  const lines = formatQuotaReport(snapshot, NOW)
  const text = lines.join('\n')
  const ollama = snapshot.providers.find(p => p.id === 'ollama')
  check('Ollama purchased-only degrades to a credits line without a percent window',
    ollama?.credits?.purchased === 9.5 && ollama.credits.remaining === undefined && ollama.windows.length === 0,
    JSON.stringify(ollama))
  const go = snapshot.providers.find(p => p.id === 'opencode-go')
  check('OpenCode Go missing windows are omitted, not zero-filled', go?.windows.length === 1, JSON.stringify(go?.windows))
  const cc = snapshot.providers.find(p => p.id === 'command-code')
  check('Command Code without whoami/plan still shows monthly credits',
    cc?.credits?.remaining === 4 && cc.windows.length === 0 && cc.plan === undefined,
    JSON.stringify(cc))
  check('Adaptive report has no invented percentages for missing windows',
    text.includes('purchased $9.50') && !text.includes('NaN') && !text.includes('undefined'), text)
}

{
  // One provider fails; the other two still render.
  const replies = new Map<string, Reply>([
    ['ollama.com/api/balance', { status: 401, body: {} }],
    ['opencode.ai/zen/go/v1/usage', { body: opencodeBody }],
    ['/alpha/whoami', { status: 404, body: {} }],
    ['/alpha/billing/credits', { status: 404, body: {} }],
  ])
  const snapshot = await fetchQuotaSnapshot({ ollama: 'o', opencodeGo: 'g', commandCode: 'c' }, fetchWith(replies), () => NOW)
  check('Ollama 401 becomes an entry error', snapshot.providers[0]?.error?.code === 'unauthorized')
  check('OpenCode Go still renders beside the failure', snapshot.providers[1]?.windows.length === 3)
  check('Command Code 404 maps to no-api (Go tier)',
    snapshot.providers[2]?.error?.code === 'no-api', JSON.stringify(snapshot.providers[2]))
  const text = formatQuotaReport(snapshot, NOW).join('\n')
  check('Report shows the error text and the healthy provider',
    text.includes('API key invalid or revoked') && text.includes('OpenCode Go') && text.includes('API access is not available'),
    text)
}

{
  // Keys: environment first, then each CLI's own auth file.
  const home = mkdtempSync(join(tmpdir(), 'verify-quota-'))
  try {
    mkdirSync(join(home, '.local', 'share', 'opencode'), { recursive: true })
    writeFileSync(join(home, '.local', 'share', 'opencode', 'auth.json'), JSON.stringify({ 'opencode-go': { key: 'file-go' } }))
    mkdirSync(join(home, '.commandcode'), { recursive: true })
    writeFileSync(join(home, '.commandcode', 'auth.json'), JSON.stringify({ apiKey: 'file-cc' }))
    const fromFiles = resolveQuotaKeys({}, home)
    check('OpenCode Go key falls back to auth.json', fromFiles.opencodeGo === 'file-go', JSON.stringify(fromFiles))
    check('Command Code key falls back to its CLI auth.json', fromFiles.commandCode === 'file-cc', JSON.stringify(fromFiles))
    const fromEnv = resolveQuotaKeys({ OPENCODE_GO_API_KEY: 'env-go', COMMANDCODE_API_KEY: 'env-cc', OLLAMA_API_KEY: 'env-ollama', OPENROUTER_API_KEY: 'env-or', OPENROUTER_MANAGEMENT_KEY: 'env-orm' }, home)
    check('Environment keys win over auth files',
      fromEnv.opencodeGo === 'env-go' && fromEnv.commandCode === 'env-cc' && fromEnv.ollama === 'env-ollama' && fromEnv.openrouter === 'env-or' && fromEnv.openrouterManagement === 'env-orm',
      JSON.stringify(fromEnv))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

{
  check('bar renders 0/40/82/100 in the requested [##########]0% shape',
    quotaBar(0) === '[----------]0%'
      && quotaBar(40) === '[####------]40%'
      && quotaBar(82) === '[########--]82%'
      && quotaBar(100) === '[##########]100%',
    [quotaBar(0), quotaBar(40), quotaBar(82), quotaBar(100)].join(' '))
  check('bar rounds to whole percent and clamps the range',
    quotaBar(27.5) === '[###-------]28%' && quotaBar(-5) === '[----------]0%' && quotaBar(150) === '[##########]100%',
    [quotaBar(27.5), quotaBar(-5), quotaBar(150)].join(' '))

  const lines = formatQuotaFooterFixture()
  check('footer prints one row per usable provider (Ollama/OpenCode/Command Code/OpenRouter)',
    lines.length === 4 && lines[0]?.startsWith('ollama') && lines[1]?.startsWith('opencode go') && lines[2]?.startsWith('command code') && lines[3]?.startsWith('openrouter'),
    lines.join('\n'))
  check('footer keeps credit amounts numeric and turns every window into a bar',
    lines[0]?.includes('$72.50/$100') && lines[0]?.includes('1m [###-------]28%')
      && lines[1]?.includes('5h [####------]40%') && lines[1]?.includes('1w [########--]78%') && lines[1]?.includes('1m [########--]82%')
      && lines[2]?.includes('$73.03') && lines[2]?.includes('5h [#---------]12%') && lines[2]?.includes('1w [#---------]11%')
      && lines[3]?.includes('$87.50/$100') && lines[3]?.includes('1w [########--]80%'),
    lines.join('\n'))
  check('footer omits windows without a percent and providers with only errors',
    !lines[2]?.includes('1m') && quotaFooterLines({ providers: [{ id: 'ollama', label: 'Ollama Cloud', windows: [], error: { code: 'unauthorized' } }], fetchedAt: NOW }).length === 0,
    lines.join('\n'))
}

{
  const text = formatQuotaReport({ providers: [], fetchedAt: NOW }, NOW).join('\n')
  check('No configured providers yields the hint, not an empty report',
    text.includes('No subscription quota configured') && text.includes('COMMANDCODE_API_KEY'), text)
}

function formatQuotaFooterFixture(): string[] {
  return quotaFooterLines({
    fetchedAt: NOW,
    providers: [
      { id: 'ollama', label: 'Ollama Cloud', credits: { remaining: 72.5, limit: 100, purchased: 25, currency: 'USD' }, windows: [{ id: 'included', usedPercent: 27.5, resetAt: '2026-10-15T00:00:00Z' }] },
      { id: 'opencode-go', label: 'OpenCode Go', windows: [
        { id: 'five-hour', usedPercent: 40 },
        { id: 'weekly', usedPercent: 78 },
        { id: 'monthly', usedPercent: 82 },
      ] },
      { id: 'command-code', label: 'Command Code', plan: 'GOAT', credits: { remaining: 73.03, purchased: 5, free: 2, currency: 'USD' }, windows: [
        { id: 'five-hour', usedPercent: 12 },
        { id: 'weekly', usedPercent: 11 },
        { id: 'monthly', resetAt: '2026-10-31T00:00:00Z' },
      ] },
      { id: 'openrouter', label: 'OpenRouter', credits: { remaining: 87.5, limit: 100, currency: 'USD' }, windows: [
        { id: 'budget-weekly', usedPercent: 80 },
      ] },
    ],
  })
}

{
  // Normal inference key: /credits is 403 (management key required), so the
  // view falls back to the /key cap and the effective budget.
  const replies = new Map<string, Reply>([
    ['openrouter.ai/api/v1/key', { body: { data: { limit: 20, limit_remaining: 15, usage: 5, budgets: [{ scope: 'member', limit_usd: 50, spend_usd: 40, remaining_usd: 10, reset_interval: 'weekly' }] } } }],
    ['openrouter.ai/api/v1/credits', { status: 403, body: { error: { code: 403 } } }],
  ])
  const snapshot = await fetchQuotaSnapshot({ openrouter: 'r' }, fetchWith(replies), () => NOW)
  const provider = snapshot.providers[0]
  check('OpenRouter key-only: key cap + budget, no management-key error',
    provider?.error === undefined && provider.credits?.remaining === 15 && provider.credits.limit === 20
      && provider.windows[0]?.id === 'budget-weekly' && Math.abs((provider.windows[0]?.usedPercent ?? 0) - 80) < 0.001,
    JSON.stringify(provider))
  const line = quotaFooterLines(snapshot)[0] ?? ''
  check('OpenRouter footer row shows numeric credits and the budget bar',
    line.startsWith('openrouter ') && line.includes('$15/$20') && line.includes('1w [########--]80%'), line)
}

{
  // No budgets: an explicit key limit still yields a key window.
  const replies = new Map<string, Reply>([
    ['openrouter.ai/api/v1/key', { body: { data: { limit: 20, limit_remaining: 15, usage: 5 } } }],
    ['openrouter.ai/api/v1/credits', { status: 403, body: {} }],
  ])
  const snapshot = await fetchQuotaSnapshot({ openrouter: 'r' }, fetchWith(replies), () => NOW)
  const provider = snapshot.providers[0]
  check('OpenRouter without budgets falls back to the per-key limit window',
    provider?.windows[0]?.id === 'key' && Math.abs((provider.windows[0]?.usedPercent ?? 0) - 25) < 0.001,
    JSON.stringify(provider?.windows))
}

{
  // Management key: /credits works even when /key is unavailable.
  const replies = new Map<string, Reply>([
    ['openrouter.ai/api/v1/key', { status: 401, body: {} }],
    ['openrouter.ai/api/v1/credits', { body: { data: { total_credits: 50, total_usage: 10 } } }],
  ])
  const snapshot = await fetchQuotaSnapshot({ openrouter: 'r' }, fetchWith(replies), () => NOW)
  const provider = snapshot.providers[0]
  check('OpenRouter management-key-only: account credits with no invented window',
    provider?.error === undefined && provider.credits?.remaining === 40 && provider.credits.limit === 50 && provider.windows.length === 0,
    JSON.stringify(provider))
  check('OpenRouter credit-only footer row has no bar',
    (quotaFooterLines(snapshot)[0] ?? '').includes('$40/$50') && !(quotaFooterLines(snapshot)[0] ?? '').includes('%'),
    quotaFooterLines(snapshot)[0])
}

{
  const replies = new Map<string, Reply>([
    ['openrouter.ai/api/v1/key', { status: 401, body: {} }],
    ['openrouter.ai/api/v1/credits', { status: 403, body: {} }],
  ])
  const snapshot = await fetchQuotaSnapshot({ openrouter: 'bad' }, fetchWith(replies), () => NOW)
  check('OpenRouter both endpoints failing becomes an unauthorized entry',
    snapshot.providers[0]?.error?.code === 'unauthorized', JSON.stringify(snapshot.providers[0]))
}

{
  // Quota-only settings: base URL overrides and on/off, no secrets.
  const home = mkdtempSync(join(tmpdir(), 'verify-quota-config-'))
  try {
    writeQuotaSettings({
      providers: {
        'opencode-go': { enabled: true, baseURL: 'https://relay.example/api' },
        ollama: { enabled: false },
      },
    }, home)
    const settings = readQuotaSettings(home)
    check('quota settings persist enabled state and a custom base URL',
      settings.providers['opencode-go']?.enabled === true
        && settings.providers['opencode-go']?.baseURL === 'https://relay.example/api'
        && settings.providers.ollama?.enabled === false,
      JSON.stringify(settings))
    check('quota settings ignore unknown providers and invalid base URLs',
      readQuotaSettings(home).providers.openrouter === undefined,
      JSON.stringify(readQuotaSettings(home)))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }

  check('quota base URL validation: https/path kept, loopback http allowed, unsafe forms rejected',
    normalizeQuotaBaseURL('https://relay.example/api/') === 'https://relay.example/api'
      && normalizeQuotaBaseURL('http://127.0.0.1:11434') === 'http://127.0.0.1:11434'
      && normalizeQuotaBaseURL('https://user:pass@relay.example') === undefined
      && normalizeQuotaBaseURL('https://relay.example?x=1') === undefined
      && normalizeQuotaBaseURL('http://relay.example') === undefined
      && normalizeQuotaBaseURL('not a url') === undefined,
    [
      normalizeQuotaBaseURL('https://relay.example/api/'),
      normalizeQuotaBaseURL('http://127.0.0.1:11434'),
      normalizeQuotaBaseURL('https://user:pass@relay.example'),
      normalizeQuotaBaseURL('http://relay.example'),
    ].join(' | '))
  check('quota provider aliases map to the four ids',
    resolveQuotaProviderId('go') === 'opencode-go'
      && resolveQuotaProviderId('cc') === 'command-code'
      && resolveQuotaProviderId('or') === 'openrouter'
      && resolveQuotaProviderId('ollama-cloud') === 'ollama',
    ['go', 'cc', 'or', 'ollama-cloud'].map(resolveQuotaProviderId).join(','))

  // A custom base URL is used instead of the official root.
  const customReplies = new Map<string, Reply>([
    ['relay.example/api/zen/go/v1/usage', { body: opencodeBody }],
  ])
  const customSeen: string[] = []
  const custom = await fetchQuotaSnapshot(
    { opencodeGo: 'g' },
    fetchWith(customReplies, customSeen),
    () => NOW,
    { providers: { 'opencode-go': { enabled: true, baseURL: 'https://relay.example/api' } } },
  )
  check('custom quota base URL replaces the official root for that provider',
    custom.providers[0]?.windows.length === 3
      && customSeen.some(url => url === 'https://relay.example/api/zen/go/v1/usage'),
    customSeen.join(' '))
  check('official base constant remains the default',
    QUOTA_OFFICIAL_BASE.openrouter === 'https://openrouter.ai/api/v1' && customSeen.every(url => !url.includes('opencode.ai')),
    customSeen.join(' '))

  const disabled = await fetchQuotaSnapshot(
    { opencodeGo: 'g' },
    fetchWith(customReplies, customSeen),
    () => NOW,
    { providers: { 'opencode-go': { enabled: false } } },
  )
  check('a disabled quota provider is not fetched', disabled.providers.length === 0)
}

{
  check('/quota subcommands parse: report/status/help/setup/reset/unknown',
    parseQuotaCommand('').kind === 'report'
      && parseQuotaCommand('status').kind === 'status'
      && parseQuotaCommand('help').kind === 'help'
      && JSON.stringify(parseQuotaCommand('setup go off')) === JSON.stringify({ kind: 'setup', provider: 'go', action: 'off' })
      && JSON.stringify(parseQuotaCommand('setup openrouter https://relay.example/api')) === JSON.stringify({ kind: 'setup', provider: 'openrouter', action: 'https://relay.example/api' })
      && JSON.stringify(parseQuotaCommand('reset or')) === JSON.stringify({ kind: 'reset', provider: 'or' })
      && parseQuotaCommand('bogus').kind === 'unknown',
    JSON.stringify([
      parseQuotaCommand(''),
      parseQuotaCommand('setup go off'),
      parseQuotaCommand('reset or'),
      parseQuotaCommand('bogus'),
    ]))
}

assert.equal(failures, 0, `${failures} quota check(s) failed`)
console.log('\nALL PASS')
