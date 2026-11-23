// Diff helpers for scripts/dsh-pr-bot.mjs: which lines a GitHub review may
// carry inline comments on, and how the model's inline blocks are parsed.

const INLINE_BLOCK = /```dsh-inline[ \t]*\r?\n([\s\S]*?)```/

function addLine(map, file, line) {
  let lines = map.get(file)
  if (lines === undefined) {
    lines = new Set()
    map.set(file, lines)
  }
  lines.add(line)
}

/** Right-side (new file) lines that appear in a unified diff. */
export function parseDiffRightLines(diffText) {
  const map = new Map()
  let file = null
  let line = 0
  for (const raw of diffText.split('\n')) {
    if (raw.startsWith('+++ ')) {
      const target = raw.slice(4).trim()
      file = target === '/dev/null' ? null : target.replace(/^b\//, '')
      continue
    }
    if (raw.startsWith('@@')) {
      const match = /\+(\d+)/.exec(raw)
      line = match === null ? 0 : Number(match[1])
      continue
    }
    if (file === null || line === 0) continue
    if (raw.startsWith('+')) {
      addLine(map, file, line)
      line += 1
    } else if (raw.startsWith(' ')) {
      addLine(map, file, line)
      line += 1
    }
  }
  return map
}

/** Remove the model's inline block; return the remaining body and raw entries. */
export function extractInline(text) {
  const match = INLINE_BLOCK.exec(text)
  if (match === null) return { body: text.trim(), comments: [] }
  let comments = []
  try {
    const parsed = JSON.parse(match[1])
    if (Array.isArray(parsed)) comments = parsed
  } catch {
    comments = []
  }
  const body = (text.slice(0, match.index) + text.slice(match.index + match[0].length)).trim()
  return { body, comments }
}

/** Keep only comments GitHub accepts: known file, right-side diff line, unique. */
export function filterInlineComments(comments, rightLines, limit = 12) {
  const accepted = []
  const seen = new Set()
  for (const candidate of comments) {
    if (candidate === null || typeof candidate !== 'object') continue
    const file = String(candidate.path ?? '').replace(/^\.?\/+/, '')
    const line = Number(candidate.line)
    const body = typeof candidate.body === 'string' ? candidate.body.trim() : ''
    if (file === '' || body === '' || !Number.isInteger(line) || line < 1) continue
    if (rightLines.get(file)?.has(line) !== true) continue
    const key = `${file}:${line}`
    if (seen.has(key)) continue
    seen.add(key)
    accepted.push({ path: file, line, side: 'RIGHT', body: body.slice(0, 2000) })
    if (accepted.length >= limit) break
  }
  return accepted
}
