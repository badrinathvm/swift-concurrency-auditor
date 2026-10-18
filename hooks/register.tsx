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

type Elements = { Box: any; Text: any }

// One file heading, then a severity line and a dim fix line per finding. The Pane and the band share it.
function findingRows({ Box, Text }: Elements, files: [string, Finding[]][]) {
  return files.map(([path, list]) => (
    <Box flexDirection="column" marginTop={1}>
      <Text weight="semibold" color={list.length ? 'text' : 'success'}>
        {list.length ? '' : '✓ '}{path.split('/').pop()}
      </Text>
      {list.map(f => (
        <Box flexDirection="column">
          <Text wrap="truncate-end">
            <Text color={SEV_COLOR[f.sev]}>{f.sev.toUpperCase()}</Text> {f.id} line {f.line}: {f.title}
          </Text>
          <Text dimColor wrap="truncate-end">  fix: {f.fix}</Text>
        </Box>
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
    $.ui.log(`${name}: ${findings.length} concurrency finding(s)${c.critical + c.high ? ` (${c.critical + c.high} critical/high)` : ''}`)
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
    const cwd = await $.session.cwd()
    const when = new Date(await $.clock.now()).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
    await $.fs.write(REPORT_PATH, buildReport(map, cwd, when))
    await update($, band, (): Band => ({ status: 'shown', source: 'report', reportPath: REPORT_PATH }))
    return { text: `Concurrency findings shown above the prompt (also written to ${REPORT_PATH})` }
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
    $.ui.status(statusText(await read($, byFile)))
    await update($, band, (): Band => ({ status: 'shown', source: 'audit' }))
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
    const c = counts(files.flatMap(([, l]) => l))
    return (
      <Box flexDirection="column">
        <Text weight="bold">
          {files.length} file(s) · {c.critical} critical · {c.high} high · {c.medium} medium · {c.low} low
        </Text>
        {findingRows({ Box, Text }, files)}
        <Box marginTop={1}>
          <Text dimColor>/concurrency-report shows these above the prompt and writes the HTML dashboard · // audit:ignore CAxxx silences a line</Text>
        </Box>
      </Box>
    )
  })

  // The inline view of the findings, drawn above the prompt the way /enhance draws its result.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.isWorking) return next(e)
    const state = await read($, band)
    if (state.status === 'hidden') return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const files = Object.entries(await read($, byFile))
    const all = files.flatMap(([, l]) => l)
    const c = counts(all)
    const lead = c.critical ? 'error' : c.high || c.medium ? 'warning' : 'success'
    const dismiss = () => update($, band, (): Band => ({ status: 'hidden' }))

    return (
      <Box flexDirection="column">
        {all.length ? (
          <Text wrap="truncate-end">
            <Text color={lead} weight="bold">🛡 Concurrency audit · Swift 6 readiness {readiness(all)}/100</Text>
            <Text> · {files.length} file(s) · {c.critical} critical · {c.high} high · {c.medium} med · {c.low} low</Text>
          </Text>
        ) : (
          <Text color="success">✓ No concurrency findings in {files.length} Swift file(s)</Text>
        )}
        {all.length ? findingRows({ Box, Text }, files.filter(([, l]) => l.length)) : null}
        <Box marginTop={1}>
          <Button key="pane" label="Open pane" onPress={() => $.ui.open({ id: PANE, title: 'Swift concurrency' })} />
          <Text> </Text>
          <Button key="dismiss" label="Dismiss" onPress={dismiss} />
          {state.reportPath ? <Text dimColor> HTML: {state.reportPath}</Text> : null}
        </Box>
      </Box>
    )
  })
}
