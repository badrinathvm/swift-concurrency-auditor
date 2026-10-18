import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Band, Finding, Severity } from '../types'
import { audit, counts, fingerprint, reminder } from './rules'
import { buildReport, readiness } from './report'

const PANE = 'swift-concurrency'
const REPORT_PATH = '.concurrency-audit/report.html'
const byFile = atom({ plugin: 'swift-concurrency-auditor', key: 'byFile' } as const, {})
const band = atom({ plugin: 'swift-concurrency-auditor', key: 'band' } as const, { status: 'hidden' } as Band)

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

// One compact row per finding; the why, the snippet and the fix live in the HTML report. The Pane and the band share it.
function findingRows({ Box, Text }: Elements, files: [string, Finding[]][]) {
  return files.map(([path, list]) => (
    <Box flexDirection="column" marginTop={1}>
      <Text weight="semibold" color={list.length ? 'text' : 'success'}>
        {list.length ? '' : '✓ '}{path.split('/').pop()}
      </Text>
      {list.map(f => (
        <Text wrap="truncate-end">
          <Text color={SEV_COLOR[f.sev]} weight="bold">{f.sev.toUpperCase().padEnd(8)}</Text> {f.id}  line {f.line}  {f.title}
        </Text>
      ))}
    </Box>
  ))
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
    const { Box, Text } = $.ui.resolve(e)
    const map = await read($, byFile)
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
        {findingRows({ Box, Text }, files)}
        <Box marginTop={1}>
          <Text dimColor>/concurrency-report writes the full HTML report · // audit:ignore CAxxx silences a line</Text>
        </Box>
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
