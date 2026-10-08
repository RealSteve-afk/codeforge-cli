

const RESET = '\x1b[0m'
const SHADE = ' .:-=+*#%@'
const CELL_ASPECT = 0.52
const CAM = 5.35
const FOCAL = 4.7
const LOOK_Y = 0.72
const KEY = norm([-0.62, 0.72, 0.32])
const FILL = norm([0.55, 0.18, 0.82])
const VIEW = [0, 0.08, 1] as const
const INK: [number, number, number] = [198, 186, 168]
const FRUIT_RGB: [number, number, number] = [184, 90, 58]
const HILL_RGB: [number, number, number] = [92, 84, 72]
const TREE_SEED = 20260817
const MAX_DEPTH = 5

export interface TreeFrameOptions {
  cols?: number
  rows?: number
  phase?: number
  grow?: number
  color?: boolean
}

type Kind = 'wood' | 'fruit' | 'ground'

interface Cell {
  z: number
  shade: number
  spec: number
  kind: Kind
}

interface Branch {
  ax: number
  ay: number
  az: number
  bx: number
  by: number
  bz: number
  radius: number
  depth: number
  t0: number
  t1: number
  tip: boolean
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value))
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function norm(v: number[]): [number, number, number] {
  const length = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / length, v[1] / length, v[2] / length]
}

function cross(a: number[], b: number[]): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[2],
  ]
}

function dot(a: number[], b: readonly number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function add(a: number[], b: number[], s = 1): [number, number, number] {
  return [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s]
}

function rotateY(x: number, z: number, angle: number): [number, number] {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return [x * c + z * s, -x * s + z * c]
}

function rotateX(y: number, z: number, angle: number): [number, number] {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return [y * c - z * s, y * s + z * c]
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function perpFrame(dir: number[]): [[number, number, number], [number, number, number]] {
  const helper = Math.abs(dir[1]) < 0.86 ? [0, 1, 0] : [1, 0, 0]
  const n1 = norm(cross(dir, helper))
  const n2 = norm(cross(dir, n1))
  return [n1, n2]
}

let cached: { seed: number; branches: Branch[] } | null = null

function headingFrom(yaw: number, pitch: number): [number, number, number] {
  const sp = Math.sin(pitch)
  return norm([sp * Math.sin(yaw), Math.cos(pitch), sp * Math.cos(yaw)])
}

export function buildTree3d(seed = TREE_SEED): Branch[] {
  if (cached && cached.seed === seed) return cached.branches
  const rng = mulberry32(seed)
  const branches: Branch[] = []
  const grow = (
    origin: [number, number, number],
    yaw: number,
    pitch: number,
    len: number,
    radius: number,
    depth: number,
    t0: number,
  ) => {
    if (depth > MAX_DEPTH || len < 0.08 || branches.length > 150) return
    const heading = headingFrom(yaw, pitch)
    const end: [number, number, number] = add(origin, heading, len)
    const t1 = Math.min(1, t0 + len / 2.8)
    const childCount = depth >= MAX_DEPTH ? 0 : rng() < 0.74 ? 2 : 3
    branches.push({
      ax: origin[0],
      ay: origin[1],
      az: origin[2],
      bx: end[0],
      by: end[1],
      bz: end[2],
      radius,
      depth,
      t0,
      t1,
      tip: childCount === 0,
    })
    const baseYaw = yaw + (rng() - 0.5) * 0.4
    for (let i = 0; i < childCount; i += 1) {
      const fork = ((i - (childCount - 1) / 2) * 2 * Math.PI) / childCount
      const childYaw = baseYaw + fork + (rng() - 0.5) * 0.35
      const childPitch = Math.min(0.98, pitch + (depth === 0 ? 0.4 : 0.26) + rng() * 0.22)
      grow(end, childYaw, childPitch, len * (0.66 + rng() * 0.12), radius * 0.67, depth + 1, t1 + rng() * 0.02)
    }
  }
  grow([0, 0, 0], 0.1, 0.03, 0.82, 0.095, 0, 0)
  const tMax = branches.reduce((m, b) => Math.max(m, b.t1), 0) || 1
  for (const b of branches) {
    b.t0 /= tMax
    b.t1 /= tMax
  }
  cached = { seed, branches }
  return branches
}

function shadeChar(shade: number): string {
  return SHADE[Math.round(clamp(shade, 0, 1) * (SHADE.length - 1))] || '@'
}

function ansiRgb(r: number, g: number, b: number): string {
  return `\x1b[38;2;${r};${g};${b}m`
}

function plot(
  grid: Array<Array<Cell | null>>,
  col: number,
  row: number,
  depth: number,
  shade: number,
  spec: number,
  kind: Kind,
): void {
  if (col < 0 || row < 0 || row >= grid.length || col >= grid[0].length) return
  if (!Number.isFinite(col) || !Number.isFinite(row) || !Number.isFinite(depth)) return
  const prev = grid[row][col]
  if (!prev || depth < prev.z) {
    grid[row][col] = { z: depth, shade: clamp(shade, 0.05, 1), spec, kind }
  }
}

function project(
  x: number,
  y: number,
  z: number,
  yaw: number,
  pitch: number,
  cols: number,
  rows: number,
): { col: number; row: number; depth: number } | null {
  ;[x, z] = rotateY(x, z, yaw)
  ;[y, z] = rotateX(y - LOOK_Y, z, pitch)
  const depth = CAM - z
  if (depth < 0.45 || !Number.isFinite(depth)) return null
  const px = (x * FOCAL) / depth
  const py = (y * FOCAL) / depth
  if (!Number.isFinite(px) || !Number.isFinite(py)) return null
  const scale = Math.min((cols * 0.9) / 2.05, (rows * 0.88) / (1.85 * CELL_ASPECT))
  const col = Math.round(px * scale + (cols - 1) / 2)
  const row = Math.round(-py * scale * CELL_ASPECT + rows * 0.54)
  return { col, row, depth }
}

function light(normal: [number, number, number], back = false): { shade: number; spec: number } {
  const facing = dot(normal, VIEW)
  if (facing < 0) {
    normal = [-normal[0], -normal[1], -normal[2]]
    back = true
  }
  const lambert = Math.max(0, dot(normal, KEY))
  const fill = Math.max(0, dot(normal, FILL)) * 0.22
  const cam = Math.max(0, dot(normal, VIEW)) * 0.2
  const half = norm([KEY[0] + VIEW[0], KEY[1] + VIEW[1], KEY[2] + VIEW[2]])
  const spec = Math.pow(Math.max(0, dot(normal, half)), 22)
  const rim = Math.pow(1 - Math.abs(dot(normal, VIEW)), 2.1) * 0.22
  const ambient = back ? 0.1 : 0.2
  const lit = ambient + lambert * (back ? 0.28 : 0.72) + fill + cam + spec * 0.45 + rim
  return { shade: clamp(Math.pow(lit, 1.15), 0.07, 1), spec }
}

function swayAt(x: number, y: number, z: number, phase: number): [number, number, number] {
  const h = clamp(y / 2.3, 0, 1)
  const gust = Math.sin(phase * 1.7 + x * 1.4 + z * 0.8)
  const lean = 0.11 * h * h * gust
  return [x + lean, y, z + lean * 0.35]
}

function sampleBranch(
  grid: Array<Array<Cell | null>>,
  branch: Branch,
  grow: number,
  phase: number,
  yaw: number,
  pitch: number,
  cols: number,
  rows: number,
): void {
  if (grow <= branch.t0) return
  const visible = clamp((grow - branch.t0) / Math.max(0.02, branch.t1 - branch.t0), 0, 1)
  const along = Math.max(4, Math.ceil((branch.depth <= 1 ? 24 : branch.depth <= 3 ? 12 : 6) * visible))
  const rings = branch.depth <= 1 ? 9 : branch.depth <= 3 ? 4 : 2
  const dx = branch.bx - branch.ax
  const dy = branch.by - branch.ay
  const dz = branch.bz - branch.az
  const dir = norm([dx, dy, dz])
  const [n1, n2] = perpFrame(dir)
  for (let i = 0; i <= along; i += 1) {
    const t = (i / along) * visible
    const px = branch.ax + dx * t
    const py = branch.ay + dy * t
    const pz = branch.az + dz * t
    const radius = branch.radius * (1 - t * 0.28)
    for (let r = 0; r < rings; r += 1) {
      const a = (r / rings) * Math.PI * 2 + phase * 0.05
      const ox = n1[0] * Math.cos(a) + n2[0] * Math.sin(a)
      const oy = n1[1] * Math.cos(a) + n2[1] * Math.sin(a)
      const oz = n1[2] * Math.cos(a) + n2[2] * Math.sin(a)
      const [sx, sy, sz] = swayAt(px + ox * radius, py + oy * radius, pz + oz * radius, phase)
      let nx = ox
      let ny = oy
      let nz = oz
      ;[nx, nz] = rotateY(nx, nz, yaw)
      ;[ny, nz] = rotateX(ny, nz, pitch)
      const hit = project(sx, sy, sz, yaw, pitch, cols, rows)
      if (!hit) continue
      const lit = light(norm([nx, ny, nz]))
      const fog = 0.45 + 0.55 * clamp(1 - (hit.depth - 5.2) / 4.2, 0, 1)
      plot(grid, hit.col, hit.row, hit.depth, lit.shade * fog, lit.spec * fog, 'wood')
    }
  }
}

function sampleFruit(
  grid: Array<Array<Cell | null>>,
  branches: Branch[],
  grow: number,
  phase: number,
  yaw: number,
  pitch: number,
  cols: number,
  rows: number,
): void {
  const placed: Array<[number, number, number]> = []
  const gap = 0.28
  let count = 0
  for (const branch of branches) {
    if (!branch.tip || grow < branch.t1) continue
    if (placed.some((p) => Math.hypot(p[0] - branch.bx, p[1] - branch.by, p[2] - branch.bz) < gap)) continue
    placed.push([branch.bx, branch.by, branch.bz])
    const [bx, by, bz] = swayAt(branch.bx, branch.by, branch.bz, phase)
    const hit = project(bx, by, bz, yaw, pitch, cols, rows)
    if (!hit) continue
    const twinkle = 0.88 + 0.12 * Math.sin(phase * 3.1 + branch.bx * 7)
    plot(grid, hit.col, hit.row, hit.depth - 0.02, 0.92 * twinkle, 0.55, 'fruit')
    count += 1
    if (count >= 22) break
  }
}

function sampleGround(
  grid: Array<Array<Cell | null>>,
  phase: number,
  yaw: number,
  pitch: number,
  cols: number,
  rows: number,
): void {
  for (let ix = -16; ix <= 16; ix += 1) {
    for (let iz = -14; iz <= 14; iz += 1) {
      const x = ix * 0.12
      const z = iz * 0.12
      const rr = (x * x) / (1.85 * 1.85) + (z * z) / (1.45 * 1.45)
      if (rr > 1) continue
      if (rr < 0.88 && rr > 0.18 && (ix * 3 + iz * 5) % 4 !== 0) continue
      const y =
        0.05 * Math.sin(x * 1.6 + 0.5) * Math.cos(z * 1.25) +
        0.018 * Math.sin(x * 3.0 + z * 2.1 + phase * 0.15)
      const hit = project(x, y, z, yaw, pitch, cols, rows)
      if (!hit) continue
      const nx = -0.08 * Math.cos(x * 1.6 + 0.5)
      const nz = 0.06 * Math.sin(z * 1.25)
      let nnx = nx
      let nny = 1
      let nnz = nz
      ;[nnx, nnz] = rotateY(nnx, nnz, yaw)
      ;[nny, nnz] = rotateX(nny, nnz, pitch)
      const lit = light(norm([nnx, nny, nnz]), true)
      const fog = 0.22 + 0.35 * clamp(1 - rr, 0, 1) * clamp(1 - (hit.depth - 5.2) / 4.8, 0, 1)
      plot(grid, hit.col, hit.row, hit.depth + 0.1, lit.shade * fog, 0, 'ground')
    }
  }
}

function paintCell(cell: Cell, color: boolean): string {
  const ch = cell.kind === 'fruit' ? '\u2022' : shadeChar(cell.shade)
  if (!color) return ch
  const base = cell.kind === 'fruit' ? FRUIT_RGB : cell.kind === 'ground' ? HILL_RGB : INK
  const lift = 0.22 + cell.shade * 0.95 + cell.spec * 0.55
  const r = clamp(Math.round(base[0] * lift), 0, 255)
  const g = clamp(Math.round(base[1] * lift), 0, 255)
  const b = clamp(Math.round(base[2] * lift), 0, 255)
  if (![r, g, b].every(Number.isFinite)) return ch
  return `${ansiRgb(r, g, b)}${ch}${RESET}`
}

export function treeFrameHeight(columns = 80): number {
  if (columns < 44) return 10
  if (columns < 68) return 14
  return 18
}

export function treeFrameWidth(columns = 80): number {
  if (columns < 44) return Math.max(28, columns)
  if (columns < 68) return Math.min(52, columns)
  return Math.min(72, Math.max(56, columns - 2))
}

export function renderTreeFrame(options: TreeFrameOptions = {}): string {
  const cols = Math.max(24, Math.floor(options.cols ?? 64))
  const rows = Math.max(8, Math.floor(options.rows ?? 16))
  const phase = options.phase ?? 0.4
  const grow = clamp(options.grow ?? 1, 0, 1)
  const color = options.color !== false
  const grid: Array<Array<Cell | null>> = Array.from({ length: rows }, () => Array(cols).fill(null))
  const yaw = 0.42 + 0.62 * Math.sin(phase)
  const pitch = 0.3 + 0.07 * Math.cos(phase * 0.85)
  const branches = buildTree3d()
  sampleGround(grid, phase, yaw, pitch, cols, rows)
  for (const branch of branches) sampleBranch(grid, branch, grow, phase, yaw, pitch, cols, rows)
  sampleFruit(grid, branches, grow, phase, yaw, pitch, cols, rows)
  return grid
    .map((line) => line.map((cell) => (cell ? paintCell(cell, color) : ' ')).join(''))
    .join('\n')
}

export function codeforgeTreeLines(columns = 80, phase = 2.05, grow = 1): string[] {
  const art = renderTreeFrame({
    cols: treeFrameWidth(columns),
    rows: treeFrameHeight(columns),
    phase,
    grow,
    color: false,
  })
  return art.split('\n')
}

export function codeforgeTreeArt(columns = 80, color = true, phase = 2.05, grow = 1): string {
  return renderTreeFrame({
    cols: treeFrameWidth(columns),
    rows: treeFrameHeight(columns),
    phase,
    grow,
    color,
  })
}

export function codeforgeTreeWidth(columns = 80): number {
  return treeFrameWidth(columns)
}

export function codeforgeTreeHeight(columns = 80): number {
  return treeFrameHeight(columns)
}
