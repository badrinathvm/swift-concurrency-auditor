import type { Finding } from '../types'
import { counts } from './rules'
import { TEMPLATE } from './template'

const PENALTY = { critical: 15, high: 8, medium: 4, low: 1 } as const

export function readiness(all: readonly Finding[]): number {
  const c = counts(all)
  const lost = c.critical * PENALTY.critical + c.high * PENALTY.high + c.medium * PENALTY.medium + c.low * PENALTY.low
  return Math.max(0, 100 - lost)
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function buildReport(byFile: Record<string, Finding[]>, cwd: string, when: string): string {
  const all = Object.values(byFile).flat()
  const score = readiness(all)
  const circumference = 289
  const offset = Math.round(circumference * (1 - score / 100))
  const shortPath = (p: string) => (p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p)
  const rows = all.map(f => ({ ...f, file: shortPath(f.file) }))
  const clean = Object.values(byFile).filter(l => l.length === 0).length
  const meta = [
    `<span><b>${Object.keys(byFile).length}</b> Swift files touched this session</span>`,
    `<span><b>${clean}</b> clean</span>`,
    `<span>Soft check · nothing blocked</span>`,
  ].join('')
  // Keep </script> inside the JSON from closing the page's script element.
  const json = JSON.stringify(rows).replace(/</g, '\\u003c')
  return TEMPLATE
    .replace('__FINDINGS__', () => json)
    .replace('__SUB__', () => esc(`${cwd.split('/').pop() || cwd} · Claude Code session · ${when}`))
    .replace('__SCORE__', String(score))
    .replace('__OFFSET__', String(offset))
    .replace('__META__', () => meta)
}
