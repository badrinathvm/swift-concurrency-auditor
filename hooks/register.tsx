import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Band, Finding, FixState, Severity } from '../types'
import { audit, counts, fingerprint, reminder } from './rules'
import { buildReport, readiness } from './report'

const PANE = 'swift-concurrency'
const REPORT_PATH = '.concurrency-audit/report.html'
const byFile = atom({ plugin: 'swift-concurrency-auditor', key: 'byFile' } as const, {})
const band = atom({ plugin: 'swift-concurrency-auditor', key: 'band' } as const, { status: 'hidden' } as Band)
const fixes = atom({ plugin: 'swift-concurrency-auditor', key: 'fixes' } as const, {} as Record<string, FixState>)

const FIXER = 'swift-concurrency-auditor:fixer'
const FIXER_PROMPT = `You fix exactly one Swift concurrency finding that the Swift concurrency auditor reported.
- Read the file, then change only the code that causes this one finding, with the smallest edit that resolves it.
- Follow the swift-concurrency skill's guidance for the fix.
- Do not touch unrelated code, other findings, formatting or other files.
- Do not silence the finding with \`// audit:ignore\`, and do not commit or push anything.
- End with one line: FIXED: <what you changed>, or NOT FIXED: <why>.`

const SEV_COLOR: Record<Severity, string> = {
  critical: 'error', high: 'warning', medium: 'suggestion', low: 'subtle',
}

function statusText(map: Record<string, Finding[]>): string | undefined {
  const c = counts(Object.values(map).flat())
  const parts = [
    c.critical && `${c.critical} critical`,
    c.high && `${c.high} high`,
    c.medium && `${c.medium} med`,
    c.low && `${c.low} low`,
  ].filter(Boolean)
  return parts.length ? `concurrency: ${parts.join(' · ')} (/concurrency)` : undefined
}

const SEV_LABEL: Record<Severity, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' }
const SEVS: Severity[] = ['critical', 'high', 'medium', 'low']

// One line for the command output and the transcript log: counts, score and where the full report is.
function summaryLine(map: Record<string, Finding[]>, url: string): string {
  const all = Object.values(map).flat()
  const c = counts(all)
  const files = Object.keys(map).length
  const parts = SEVS.filter(s => c[s]).map(s => `${c[s]} ${s}`)
  const found = parts.length ? parts.join(' · ') : 'no findings'
  return `Concurrency: ${files} file(s) · ${found} · readiness ${readiness(all)}% · full report: ${url}`
}

// Writes the HTML dashboard and returns where it landed, for the band's link and the summary line.
async function writeReport($: any, map: Record<string, Finding[]>): Promise<{ path: string; url: string }> {
  const cwd = await $.session.cwd()
  const when = new Date(await $.clock.now()).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
  await $.fs.write(REPORT_PATH, buildReport(map, cwd, when))
  return { path: REPORT_PATH, url: `file://${encodeURI(`${cwd}/${REPORT_PATH}`)}` }
}

type Elements = { Box: any; Text: any }

// The HTML report's summary in cells: a readiness card beside four severity tiles and the meta line.
function summaryCards({ Box, Text }: Elements, map: Record<string, Finding[]>) {
  const all = Object.values(map).flat()
  const c = counts(all)
  const score = readiness(all)
  const filled = Math.round(score / 10)
  const clean = Object.values(map).filter(l => l.length === 0).length
  return (
    <Box flexDirection="row" gap={1}>
      <Box borderStyle="round" borderDimColor paddingX={2} flexDirection="column" alignItems="center" justifyContent="center">
        <Text weight="bold" size="title">{score}%</Text>
        <Text>
          <Text color="suggestion">{'█'.repeat(filled)}</Text>
          <Text dimColor>{'░'.repeat(10 - filled)}</Text>
        </Text>
        <Text dimColor>Swift 6 readiness</Text>
      </Box>
      <Box borderStyle="round" borderDimColor paddingX={1} flexDirection="column" flexGrow={1}>
        <Box flexDirection="row" gap={1}>
          {SEVS.map(s => (
            <Box borderStyle="round" borderDimColor paddingX={1} minWidth={12} flexDirection="column">
              <Text color={SEV_COLOR[s]} weight="bold" size="heading">{String(c[s])}</Text>
              <Text dimColor>{SEV_LABEL[s]}</Text>
            </Box>
          ))}
        </Box>
        <Text dimColor wrap="truncate-end">
          <Text weight="bold">{String(Object.keys(map).length)}</Text> Swift files touched this session  <Text weight="bold">{String(clean)}</Text> clean  Soft check · nothing blocked
        </Text>
      </Box>
    </Box>
  )
}

const fixKey = (f: Finding) => `${f.file}#${f.id}#${f.line}`

// What the Pane adds to each row: a Fix button whose label follows that finding's run.
type FixRow = { Button: any; runs: Record<string, FixState>; onFix: (f: Finding) => void }

function fixButton({ Button, runs, onFix }: FixRow, f: Finding) {
  const run = runs[fixKey(f)]
  const busy = Object.values(runs).some(r => r.status === 'running' && r.file === f.file)
  if (run?.status === 'running') return <Button key={fixKey(f)} label="Fixing…" dimColor onPress={() => {}} />
  if (busy) return <Button key={fixKey(f)} label="Wait" dimColor onPress={() => {}} />
  return <Button key={fixKey(f)} label={run?.status === 'failed' ? 'Retry' : 'Fix'} onPress={() => onFix(f)} />
}

// One compact row per finding; the why, the snippet and the fix live in the HTML report. The Pane and the band share it;
// only the Pane passes `fix`, which puts a Fix button beside each row.
function findingRows({ Box, Text }: Elements, files: [string, Finding[]][], fix?: FixRow) {
  return files.map(([path, list]) => (
    <Box flexDirection="column" marginTop={1}>
      <Text weight="semibold" color={list.length ? 'text' : 'success'}>
        {list.length ? '' : '✓ '}{path.split('/').pop()}
      </Text>
      {list.map(f => {
        const row = (
          <Text wrap="truncate-end">
            <Text color={SEV_COLOR[f.sev]} weight="bold">{f.sev.toUpperCase().padEnd(8)}</Text> {f.id}  line {f.line}  {f.title}
          </Text>
        )
        if (!fix) return row
        const note = fix.runs[fixKey(f)]?.note
        return (
          <Box flexDirection="row" gap={1}>
            <Box flexGrow={1} flexShrink={1}>{row}</Box>
            {fixButton(fix, f)}
            {note ? <Text dimColor wrap="truncate-end">{note}</Text> : null}
          </Box>
        )
      })}
    </Box>
  ))
}

// The task one fixer agent gets: everything the auditor knows about the one finding.
function fixPrompt(f: Finding): string {
  return [
    `Fix this one Swift concurrency finding and nothing else.`,
    ``,
    `ID: ${f.id}`,
    `Severity: ${f.sev}`,
    `File: ${f.file}`,
    `Line: ${f.line}`,
    `Finding: ${f.title}`,
    `Why: ${f.why}`,
    `Suggested fix: ${f.fix}`,
    `Code at that line:`,
    f.snippet,
  ].join('\n')
}

// Spawns a fixer for one finding, one run per file at a time so two agents never edit the same file.
async function startFix($: any, f: Finding): Promise<void> {
  const key = fixKey(f)
  const runs = await read($, fixes)
  if (Object.values(runs).some(r => r.status === 'running' && r.file === f.file)) return
  const count = ((await read($, byFile))[f.file] ?? []).filter(g => g.id === f.id).length
  const base = { id: f.id, file: f.file, line: f.line, count }
  await update($, fixes, m => ({ ...m, [key]: { ...base, status: 'running' as const } }))
  let spawned: { agentId?: string; deny?: string }
  try {
    spawned = await $.agent.spawn({
      subagentType: FIXER,
      description: `Fix ${f.id} in ${f.file.split('/').pop()}:${f.line}`,
      prompt: fixPrompt(f),
    })
  } catch (err) {
    spawned = { deny: err instanceof Error ? err.message : String(err) }
  }
  const { agentId, deny } = spawned
  const next: FixState = agentId && deny === undefined
    ? { ...base, status: 'running', agentId }
    : { ...base, status: 'failed', note: deny ?? 'the agent did not start' }
  await update($, fixes, m => ({ ...m, [key]: next }))
}

// A fixer finished: re-audit its file, so "done" means the auditor no longer sees the finding, whatever the agent said.
async function settleFix($: any, key: string, run: FixState, reason: string): Promise<void> {
  let findings: Finding[] | undefined
  try {
    findings = audit(await $.fs.read(run.file), run.file)
  } catch {
    // An unreadable file leaves the findings as they were.
  }
  if (findings) {
    await update($, byFile, map => ({ ...map, [run.file]: findings }))
    const map = await read($, byFile)
    $.ui.status(statusText(map))
    try {
      const { path: reportPath, url: reportUrl } = await writeReport($, map)
      const state = await read($, band)
      if (state.status === 'shown') await update($, band, (): Band => ({ ...state, reportPath, reportUrl }))
    } catch {
      // The report is a convenience: a failed write never fails the fix.
    }
  }
  const left = findings?.filter(g => g.id === run.id).length ?? run.count
  const fixed = reason === 'answer' && left < run.count
  const note = fixed ? undefined : reason !== 'answer' ? `agent ended: ${reason}` : 'finding still reported'
  await update($, fixes, m => ({ ...m, [key]: { ...run, status: fixed ? 'done' as const : 'failed' as const, agentId: undefined, note } }))
  const name = run.file.split('/').pop()
  $.ui.log(`${name}: ${run.id} ${fixed ? 'fixed' : `not fixed (${note})`}`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Restore the status line after a reload; the findings live in $.state.
    $.ui.status(statusText(await read($, byFile)))
    await $.command.register({ name: 'concurrency', description: 'Show Swift concurrency findings for files Claude touched' })
    await $.command.register({ name: 'concurrency-report', description: 'Write the concurrency findings as an HTML dashboard' })
    await $.command.register({
      name: 'concurrency-audit',
      description: 'Run the concurrency auditor on a Swift file now',
      argumentHint: '<path/to/File.swift>',
    })
    try {
      await $.agent.register({
        name: 'fixer',
        description: 'Fixes one Swift concurrency finding reported by the auditor',
        prompt: FIXER_PROMPT,
        tools: ['Read', 'Edit', 'Grep', 'Glob'],
        skills: ['swift-concurrency:swift-concurrency'],
      })
    } catch {
      // Without the agent type a Fix press fails with the spawn's reason; the audit still works.
    }
    return next(e)
  })

  // The fixer runs only from the pane's Fix button, never on the model's own initiative.
  on('agent.offer', { agent: FIXER }, () => ({ isOffered: false }))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const runs = await read($, fixes)
      const hit = Object.entries(runs).find(([, r]) => r.status === 'running' && r.agentId === e.agentId)
      if (hit) await settleFix($, hit[0], hit[1], e.reason)
    }
    return next(e)
  })

  // The soft check: let every Edit/Write run, then audit the Swift file it changed.
  on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny !== undefined || result.isError) return result
    const path = e.file_path
    if (!path.endsWith('.swift')) return result

    let text: string
    try {
      text = await $.fs.read(path)
    } catch {
      return result
    }

    const findings = audit(text, path)
    const before = (await read($, byFile))[path] ?? []
    await update($, byFile, map => ({ ...map, [path]: findings }))
    $.ui.status(statusText(await read($, byFile)))

    const name = path.split('/').pop()
    const changed = fingerprint(findings) !== fingerprint(before)
    if (!changed) return result

    if (findings.length === 0) {
      if (before.length) $.ui.log(`${name}: concurrency findings resolved`)
      return result
    }

    const c = counts(findings)
    const map = await read($, byFile)
    try {
      const { path: reportPath, url: reportUrl } = await writeReport($, map)
      await update($, band, (): Band => ({ status: 'shown', source: 'audit', reportPath, reportUrl }))
      $.ui.log(`${name}: ${summaryLine(map, reportUrl)}`)
    } catch {
      // The report is a convenience: a failed write never fails the edit.
      $.ui.log(`${name}: ${findings.length} concurrency finding(s)`)
    }
    if (c.critical) $.ui.toast(`${name}: possible data race (${findings.find(f => f.sev === 'critical')?.id})`)

    // Claude reads this after the tool's own result. Nothing is blocked.
    return { ...result, context: [...(result.context ?? []), reminder(path, findings)] }
  })

  on('command.run', { command: 'concurrency' }, async $ => {
    const map = await read($, byFile)
    const { isPlaced } = await $.ui.open({ id: PANE, title: 'Swift concurrency' })
    if (isPlaced) return {}
    // No surface to draw the pane on: print a summary instead.
    const all = Object.values(map).flat()
    if (!all.length) return { text: `No concurrency findings in ${Object.keys(map).length} Swift file(s) touched so far.` }
    return {
      text: all.map(f => `[${f.sev}] ${f.id} ${f.file.split('/').pop()}:${f.line} ${f.title}`).join('\n'),
    }
  })

  on('command.run', { command: 'concurrency-report' }, async $ => {
    const map = await read($, byFile)
    if (!Object.keys(map).length) return { text: 'No Swift files have been audited yet in this session.' }
    const { path: reportPath, url: reportUrl } = await writeReport($, map)
    await update($, band, (): Band => ({ status: 'shown', source: 'report', reportPath, reportUrl }))
    return { text: summaryLine(map, reportUrl) }
  })

  on('command.run', { command: 'concurrency-audit' }, async ($, e) => {
    const path = e.args.trim()
    if (!path.endsWith('.swift')) return { text: 'Usage: /concurrency-audit path/to/File.swift' }
    let text: string
    try {
      text = await $.fs.read(path)
    } catch {
      return { text: `Could not read ${path}` }
    }
    const cwd = await $.session.cwd()
    const abs = path.startsWith('/') ? path : `${cwd}/${path}`
    const findings = audit(text, abs)
    await update($, byFile, map => ({ ...map, [abs]: findings }))
    const map = await read($, byFile)
    $.ui.status(statusText(map))
    const { path: reportPath, url: reportUrl } = await writeReport($, map)
    await update($, band, (): Band => ({ status: 'shown', source: 'audit', reportPath, reportUrl }))
    // Claude reads command text too, so it can offer to fix what was found.
    return { text: findings.length ? reminder(abs, findings) : `${path}: no concurrency findings.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const map = await read($, byFile)
    const runs = await read($, fixes)
    const finished = Object.values(runs).filter(r => r.status !== 'running')
    const files = Object.entries(map)
    if (!files.length) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No Swift files touched yet. Findings appear here after Claude edits a .swift file.</Text>
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        {summaryCards({ Box, Text }, map)}
        {findingRows({ Box, Text }, files, { Button, runs, onFix: f => void startFix($, f) })}
        {finished.length ? (
          <Box flexDirection="column" marginTop={1}>
            <Text weight="semibold">Fix runs</Text>
            {finished.map(r => (
              <Text wrap="truncate-end">
                <Text color={r.status === 'done' ? 'success' : 'error'}>{r.status === 'done' ? '✓' : '✗'}</Text> {r.id} {r.file.split('/').pop()}:{r.line} {r.status === 'done' ? 'fixed' : `failed · ${r.note}`}
              </Text>
            ))}
          </Box>
        ) : null}
        <Box marginTop={1}>
          <Text dimColor>Fix starts an agent for that one finding, nothing is committed · /concurrency-report writes the full HTML report · // audit:ignore CAxxx silences a line</Text>
        </Box>
      </Box>
    )
  })

  // /concurrency-report's row draws the summary cards in place of its text line; the model still reads the text.
  on('ui.render', { component: 'CommandOutput', props: { command: 'concurrency-report' } }, async ($, e, next) => {
    if (e.props.isErrored) return next(e)
    const map = await read($, byFile)
    if (!Object.keys(map).length) return next(e)

    const { Box, Link, Text } = $.ui.resolve(e)
    const url = e.props.text.match(/file:\/\/\S+/)?.[0]
    return (
      <Box flexDirection="column">
        {summaryCards({ Box, Text }, map)}
        {url ? (
          <Text>
            <Link href={url}>Open full report ↗</Link>
            <Text dimColor> {REPORT_PATH}</Text>
          </Text>
        ) : null}
      </Box>
    )
  })

  // The inline view of the findings, drawn above the prompt the way /enhance draws its result.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.isWorking) return next(e)
    const state = await read($, band)
    if (state.status === 'hidden') return next(e)

    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const map = await read($, byFile)
    const files = Object.entries(map)
    const all = files.flatMap(([, l]) => l)
    const dismiss = () => update($, band, (): Band => ({ status: 'hidden' }))

    return (
      <Box flexDirection="column">
        <Text weight="bold">⚡ Concurrency Auditor</Text>
        {summaryCards({ Box, Text }, map)}
        {all.length ? findingRows({ Box, Text }, files.filter(([, l]) => l.length)) : null}
        <Box marginTop={1} gap={1}>
          {state.reportUrl ? (
            <Text>
              <Link href={state.reportUrl}>Open full report ↗</Link>
              <Text dimColor> {state.reportPath}</Text>
            </Text>
          ) : null}
          <Button key="pane" label="Open pane" onPress={() => $.ui.open({ id: PANE, title: 'Swift concurrency' })} />
          <Button key="dismiss" label="Dismiss" onPress={dismiss} />
        </Box>
      </Box>
    )
  })
}
