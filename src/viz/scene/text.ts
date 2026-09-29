/** The only part of a 2D context text fitting needs, so tests can fake it. */
export interface Measurer {
  font: string
  measureText(text: string): { width: number }
}

export interface FitOptions {
  maxWidth: number
  maxSize: number
  minSize: number
  /** Lines allowed; wrapping is tried only once one line at maxSize fails. */
  maxLines?: number
  /** Line height as a multiple of the size, used for the height budget. */
  lineHeight?: number
  /** Optional height budget for all lines together. */
  maxHeight?: number
  font: (px: number) => string
}

export interface FitResult {
  size: number
  lines: string[]
  /** Widest line as measured at `size`. */
  width: number
  height: number
}

const ELLIPSIS = '…'

function width(m: Measurer, s: string): number {
  return m.measureText(s).width
}

/** Graphemes, so an ellipsis never splits a surrogate pair or a combining mark. */
function graphemes(s: string): string[] {
  const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  return Array.from(seg.segment(s), (x) => x.segment)
}

/** Cuts `text` so it plus an ellipsis fits `maxWidth` at the current font. */
export function ellipsize(m: Measurer, text: string, maxWidth: number): string {
  if (width(m, text) <= maxWidth) return text
  const g = graphemes(text)
  let lo = 0
  let hi = g.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    const candidate = g.slice(0, mid).join('').trimEnd() + ELLIPSIS
    if (width(m, candidate) <= maxWidth) lo = mid
    else hi = mid - 1
  }
  const out = g.slice(0, lo).join('').trimEnd() + ELLIPSIS
  return width(m, out) <= maxWidth ? out : ''
}

/** Greedy word wrap into at most `maxLines`; the last line takes the remainder. */
function wrap(m: Measurer, text: string, maxWidth: number, maxLines: number): string[] | null {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ''
  for (let w = 0; w < words.length; w++) {
    const next = current ? `${current} ${words[w]}` : words[w]!
    if (width(m, next) <= maxWidth || !current) {
      current = next
      continue
    }
    lines.push(current)
    current = words[w]!
    if (lines.length === maxLines - 1) {
      current = words.slice(w).join(' ')
      break
    }
  }
  if (current) lines.push(current)
  if (lines.length > maxLines) return null
  return lines.every((l) => width(m, l) <= maxWidth) ? lines : null
}

/**
 * Largest size in [minSize, maxSize] at which the text fits the box, on one
 * line first and then wrapped; at minSize whatever still overflows is
 * ellipsized. Every returned line is at most maxWidth wide.
 */
export function fitText(m: Measurer, text: string, opts: FitOptions): FitResult {
  const maxLines = Math.max(1, opts.maxLines ?? 1)
  const lh = opts.lineHeight ?? 1.15
  const minSize = Math.max(1, Math.min(opts.minSize, opts.maxSize))
  const clean = text.replace(/\s+/g, ' ').trim()
  const heightOk = (size: number, n: number) => opts.maxHeight === undefined || size * lh * n <= opts.maxHeight + 0.01

  const measure = (size: number, lines: string[]): FitResult => {
    m.font = opts.font(size)
    const w = Math.max(0, ...lines.map((l) => width(m, l)))
    return { size, lines, width: w, height: size * lh * lines.length }
  }

  const step = Math.max(0.5, (opts.maxSize - minSize) / 24)
  // One line, shrinking.
  for (let size = opts.maxSize; size >= minSize - 1e-6; size -= step) {
    m.font = opts.font(size)
    if (width(m, clean) <= opts.maxWidth && heightOk(size, 1)) return measure(size, [clean])
  }
  // Wrapped, shrinking.
  if (maxLines > 1) {
    for (let size = opts.maxSize; size >= minSize - 1e-6; size -= step) {
      if (!heightOk(size, 2)) continue
      m.font = opts.font(size)
      let n = maxLines
      while (n > 1 && !heightOk(size, n)) n--
      const lines = wrap(m, clean, opts.maxWidth, n)
      if (lines) return measure(size, lines)
    }
  }
  // Minimum size, ellipsized.
  let size = minSize
  if (opts.maxHeight !== undefined) size = Math.min(size, opts.maxHeight / lh)
  m.font = opts.font(size)
  let n = maxLines
  while (n > 1 && !heightOk(size, n)) n--
  if (n > 1) {
    const words = clean.split(' ')
    const lines: string[] = []
    let rest = words
    for (let l = 0; l < n - 1 && rest.length; l++) {
      let take = 0
      let line = ''
      while (take < rest.length) {
        const candidate = line ? `${line} ${rest[take]}` : rest[take]!
        if (width(m, candidate) > opts.maxWidth) break
        line = candidate
        take++
      }
      if (take === 0) break
      lines.push(line)
      rest = rest.slice(take)
    }
    if (rest.length) lines.push(ellipsize(m, rest.join(' '), opts.maxWidth))
    return measure(size, lines.filter((l) => l.length > 0))
  }
  return measure(size, [ellipsize(m, clean, opts.maxWidth)])
}
