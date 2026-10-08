import { logoPoint, mobiusPoint, mobiusRgb, renderMobiusFrame } from './mobius'

function visibleCells(frame: string): number {
  return frame.replace(/\x1b\[[0-9;]*m/g, '').replace(/ /g, '').replace(/\n/g, '').length
}

function slice(frame: string, rowT: number, fromT: number, toT: number): number {
  const lines = frame.replace(/\x1b\[[0-9;]*m/g, '').split('\n')
  const row = lines[Math.floor(lines.length * rowT)] || ''
  const from = Math.floor(row.length * fromT)
  const to = Math.floor(row.length * toT)
  return (row.slice(from, to).match(/[^ ]/g) || []).length
}

describe('möbius ring', () => {
  it('uses a half-twist: after one full loop the width flips', () => {
    const [, , z0] = mobiusPoint(0, 1)
    const [, , zTurn] = mobiusPoint(Math.PI * 2, 1)
    const [, , zHalf] = mobiusPoint(Math.PI, 1)
    expect(z0).toBeCloseTo(0, 5)
    expect(zTurn).toBeCloseTo(0, 5)
    expect(Math.abs(zHalf)).toBeGreaterThan(0.3)
    const [x0] = mobiusPoint(0, 1)
    const [xFlip] = mobiusPoint(Math.PI * 2, -1)
    expect(x0).toBeCloseTo(xFlip, 5)
  })

  it('is an ∞: left and right lobes stay open as the twist travels', () => {
    for (const phase of [0, 1.2, 2.4, 3.8]) {
      const frame = renderMobiusFrame({ cols: 68, rows: 16, phase, color: false })
      const left = slice(frame, 0.28, 0.18, 0.32)
      const right = slice(frame, 0.28, 0.68, 0.82)
      const crossing = slice(frame, 0.5, 0.42, 0.58)
      expect(left).toBeLessThan(crossing + 3)
      expect(right).toBeLessThan(crossing + 3)
      expect(visibleCells(frame)).toBeGreaterThan(40)
    }
  })

  it('rotates: two phases are different views of the same ribbon', () => {
    const a = renderMobiusFrame({ cols: 56, rows: 14, phase: 0, color: false })
    const b = renderMobiusFrame({ cols: 56, rows: 14, phase: 1.1, color: false })
    expect(a).not.toEqual(b)
    expect(a).not.toMatch(/NaN/)
    expect(b).not.toMatch(/NaN/)
  })

  it('shades the band so the twist reads as a volume, not a silhouette', () => {
    const frame = renderMobiusFrame({ cols: 60, rows: 16, phase: 0.5, color: false })
    const marks = frame.replace(/ /g, '').replace(/\n/g, '')
    const bright = (marks.match(/[@%#]/g) || []).length
    const dim = (marks.match(/[.:-]/g) || []).length
    expect(bright).toBeGreaterThan(8)
    expect(dim).toBeGreaterThan(8)
    expect(new Set(marks.split('')).size).toBeGreaterThan(4)
  })

  it('paints the brand blue–purple–gold along the band', () => {
    expect(mobiusRgb(0)[2]).toBeGreaterThan(180)
    expect(mobiusRgb(Math.PI)[0]).toBeGreaterThan(100)
    expect(mobiusRgb(Math.PI * 2 * 0.99)[0]).toBeGreaterThan(180)
    const colored = renderMobiusFrame({ cols: 48, rows: 12, phase: 0.2, color: true })
    expect(colored).toMatch(/\x1b\[38;2;\d+;\d+;\d+m/)
  })

  it('keeps the half-twist continuous: width +1 at t and width -1 at t+2π meet', () => {
    const a = logoPoint(0.4, 1, 0)
    const b = logoPoint(0.4 + Math.PI * 2, -1, 0)
    expect(a[0]).toBeCloseTo(b[0], 5)
    expect(a[1]).toBeCloseTo(b[1], 5)
    expect(a[2]).toBeCloseTo(b[2], 5)
  })
})
