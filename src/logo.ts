export { codeforgeMarkArt, codeforgeMarkLines } from './mark'
export { codeforgeTreeArt, codeforgeTreeLines } from './tree'
import { markRgb } from './mark'
import { mobiusFrameHeight, mobiusFrameWidth, renderMobiusFrame } from './mobius'

const RESET = '\x1b[0m'
const INK = '\x1b[38;2;220;214;204m'
const INK_DIM = '\x1b[38;2;140;132;120m'

export const CODEFORGE_BRAND = {
  zh: 'CodeForge',
  en: 'CodeForge',
  headline: 'Forge ahead.',
} as const

const HEADLINE = CODEFORGE_BRAND.headline

export function codeforgeMobiusArt(columns = 80, phase = 0, color = false): string {
  return renderMobiusFrame({
    cols: mobiusFrameWidth(columns),
    rows: mobiusFrameHeight(columns),
    phase,
    color,
  })
}

export function codeforgeWordmark(): string {
  return [CODEFORGE_BRAND.zh, CODEFORGE_BRAND.en.toUpperCase()].join('\n')
}


export function codeforgeProductSurfaces(): { splash: string; welcome: string; helpAbout: string } {
  return {
    splash: stripAnsi(codeforgeSplash(72, false)),
    welcome: codeforgeWelcomeCopy(false, false).join('\n'),
    helpAbout: `codeforge — ${CODEFORGE_BRAND.en} · ${CODEFORGE_BRAND.headline}`,
  }
}

export function displayWidth(text: string): number {
  return visibleWidth(text)
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  )
}


function visibleWidth(line: string): number {
  let width = 0
  for (const ch of stripAnsi(line)) width += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1
  return width
}

function paint(text: string, prefix: string, color: boolean): string {
  if (!color || !text) return text
  return `${prefix}${text}${RESET}`
}

function infinityMark(color: boolean): string {
  if (!color) return '∞'
  const [r, g, b] = markRgb(0, 2)
  return `\x1b[38;2;${r};${g};${b}m∞${RESET}`
}

function lockup(color: boolean): string[] {
  const inf = infinityMark(color)
  const name = paint(CODEFORGE_BRAND.zh, INK, color)
  const latin = paint(CODEFORGE_BRAND.en.toUpperCase(), INK_DIM, color)
  return [`${inf}  ${name}`, latin]
}

function padLeft(text: string, n: number): string {
  return `${' '.repeat(Math.max(0, n))}${text}`
}

function center(text: string, width: number): string {
  const vis = displayWidth(text)
  const pad = Math.max(0, Math.floor((width - vis) / 2))
  return padLeft(text, pad)
}

function centerBlock(lines: string[], width: number): string[] {
  return lines.map((line) => center(line, width))
}

export const CODEFORGE_STILL_PHASE = 0.85
const STILL_PHASE = CODEFORGE_STILL_PHASE


export function codeforgeSplashFrame(columns = 80, color = true, phase = STILL_PHASE, _grow = 1): string {
  const width = Math.max(20, Math.floor(columns))
  const ringW = mobiusFrameWidth(width)
  const ring = renderMobiusFrame({
    cols: ringW,
    rows: mobiusFrameHeight(width),
    phase,
    color,
  }).split('\n')
  const pad = Math.max(0, Math.floor((width - ringW) / 2))
  const art = ring.map((line) => padLeft(line, pad))
  const caption = centerBlock(
    [
      `${infinityMark(color)}  ${paint(CODEFORGE_BRAND.zh, INK, color)}   ${paint(CODEFORGE_BRAND.en.toUpperCase(), INK_DIM, color)}`,
      paint(HEADLINE, INK, color),
    ],
    width,
  )
  return [...art, '', ...caption].join('\n')
}

export function codeforgeSplashHeight(columns = 80): number {
  return codeforgeSplashFrame(columns, false).split('\n').length
}

export function codeforgeSplash(columns = 80, color = true): string {
  return codeforgeSplashFrame(columns, color, STILL_PHASE, 1)
}

export function codeforgeWelcomeCopy(guest: boolean, color = true): string[] {
  const lines = [
    ...lockup(color),
    paint(HEADLINE, INK, color),
  ]
  if (guest) {
    lines.push(paint('Sign in to start a conversation.', INK_DIM, color))
    lines.push(paint('/login  browser    /help  commands', INK_DIM, color))
  } else {
    lines.push(paint('Ask anything, or type /help.', INK_DIM, color))
  }
  return lines
}

export function codeforgeBanner(columns = 80, phase = STILL_PHASE, color = false): string {
  return codeforgeSplashFrame(columns, color, phase, 1)
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}
