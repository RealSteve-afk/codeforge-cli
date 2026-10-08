import { renderTreeFrame, codeforgeTreeArt, codeforgeTreeHeight, codeforgeTreeLines, codeforgeTreeWidth } from './tree'

function visible(frame: string): string {
  return frame.replace(/\x1b\[[0-9;]*m/g, '').replace(/ /g, '').replace(/\n/g, '')
}

it('keeps a fixed grid so the intro can rewrite in place', () => {
  for (const cols of [80, 50, 30]) {
    const lines = codeforgeTreeLines(cols)
    const width = lines[0].length
    expect(lines.every((line) => line.length === width)).toBe(true)
    expect(lines.length).toBe(codeforgeTreeHeight(cols))
  }
  expect(codeforgeTreeWidth(80)).toBeGreaterThan(codeforgeTreeWidth(40))
})

it('shades the tree as a volume: bright wood, dim wood, and terracotta fruit', () => {
  const frame = renderTreeFrame({ cols: 68, rows: 17, phase: 2.05, grow: 1, color: false })
  const marks = visible(frame)
  const bright = (marks.match(/[@%#]/g) || []).length
  const dim = (marks.match(/[.:-]/g) || []).length
  expect(bright).toBeGreaterThan(8)
  expect(dim).toBeGreaterThan(8)
  expect(marks).toContain('\u2022')
  expect(new Set(marks.split('')).size).toBeGreaterThan(5)
  const colored = codeforgeTreeArt(80, true)
  expect(colored).toMatch(/\x1b\[38;2;\d+;\d+;\d+m/)
  expect(colored).toContain('\u2022')
  expect(colored).not.toMatch(/NaN/)
})

it('orbits: two phases are different views of the same tree', () => {
  const a = renderTreeFrame({ cols: 64, rows: 16, phase: 0.2, grow: 1, color: false })
  const b = renderTreeFrame({ cols: 64, rows: 16, phase: 2.1, grow: 1, color: false })
  expect(a).not.toEqual(b)
  expect(visible(a).length).toBeGreaterThan(40)
  expect(visible(b).length).toBeGreaterThan(40)
})

it('grows: a sapling has fewer cells than the finished crown', () => {
  const young = visible(renderTreeFrame({ cols: 64, rows: 16, phase: 0.5, grow: 0.22, color: false }))
  const grown = visible(renderTreeFrame({ cols: 64, rows: 16, phase: 0.5, grow: 1, color: false }))
  expect(grown.length).toBeGreaterThan(young.length + 20)
})
