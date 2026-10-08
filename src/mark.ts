

const RESET = '\x1b[0m'

const MARK_WIDE = [
  '     ▄▄████▄▄            ▄▄████▄▄     ',
  '   ▄██▀    ▀██▄        ▄██▀    ▀██▄   ',
  '  ██          ▀█▄    ▄█▀          ██  ',
  '  ██            ▀████▀            ██  ',
  '  ██            ▄████▄            ██  ',
  '  ██          ▄█▀    ▀█▄          ██  ',
  '   ▀██▄    ▄██▀        ▀██▄    ▄██▀   ',
  '     ▀▀████▀▀            ▀▀████▀▀     ',
]

const MARK_NARROW = [
  '   ▄██▄      ▄██▄   ',
  '  █▀  ▀█▄  ▄█▀  ▀█  ',
  '  █     ▀██▀     █  ',
  '  █     ▄██▄     █  ',
  '  █▄  ▄█▀  ▀█▄  ▄█  ',
  '   ▀██▀      ▀██▀   ',
]

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}


export function markRgb(x: number, width: number): [number, number, number] {
  const t = width <= 1 ? 0 : Math.max(0, Math.min(1, x / (width - 1)))
  if (t < 0.5) {
    const k = t / 0.5
    return [
      Math.round(lerp(37, 124, k)),
      Math.round(lerp(99, 58, k)),
      Math.round(lerp(235, 237, k)),
    ]
  }
  const k = (t - 0.5) / 0.5
  return [
    Math.round(lerp(124, 217, k)),
    Math.round(lerp(58, 119, k)),
    Math.round(lerp(237, 6, k)),
  ]
}

function paintLine(line: string): string {
  const width = line.length
  let out = ''
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === ' ') {
      out += ' '
      continue
    }
    const [r, g, b] = markRgb(i, width)
    out += `\x1b[38;2;${r};${g};${b}m${ch}`
  }
  return `${out}${RESET}`
}

export function codeforgeMarkLines(columns = 80): string[] {
  return columns >= 48 ? MARK_WIDE : MARK_NARROW
}

export function codeforgeMarkArt(columns = 80, color = true): string {
  const lines = codeforgeMarkLines(columns)
  const painted = color ? lines.map(paintLine) : lines
  return painted.join('\n')
}

export function codeforgeMarkWidth(columns = 80): number {
  return codeforgeMarkLines(columns).reduce((max, line) => Math.max(max, line.length), 0)
}

export function codeforgeMarkHeight(columns = 80): number {
  return codeforgeMarkLines(columns).length
}
