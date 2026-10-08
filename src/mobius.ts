

const RESET = '\x1b[0m'
const SHADE_RAMP = ' .:-=+*#%@'
const SCALE = 1.72
const HALF_WIDTH = 0.3
const THICKNESS = 0.045
const CELL_ASPECT = 0.5
const CAM = 6.4
const FOCAL = 5.2
const KEY = norm([-0.55, 0.7, 0.45])
const FILL = norm([0.52, 0.1, 0.85])
const VIEW = [0, 0.06, 1] as const

export interface MobiusFrameOptions {
  cols?: number
  rows?: number
  phase?: number
  color?: boolean
}

interface Cell {
  z: number
  shade: number
  t: number
  spec: number
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
    a[0] * b[1] - a[1] * b[0],
  ]
}

function dot(a: number[], b: readonly number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}


export function mobiusRgb(t: number): [number, number, number] {
  const u = ((t / (Math.PI * 2)) % 1 + 1) % 1
  if (u < 0.5) {
    const k = u / 0.5
    return [
      Math.round(lerp(37, 124, k)),
      Math.round(lerp(99, 58, k)),
      Math.round(lerp(235, 237, k)),
    ]
  }
  const k = (u - 0.5) / 0.5
  return [
    Math.round(lerp(124, 217, k)),
    Math.round(lerp(58, 119, k)),
    Math.round(lerp(237, 6, k)),
  ]
}

function ansiRgb(r: number, g: number, b: number): string {
  return `\x1b[38;2;${r};${g};${b}m`
}

function rotateX(y: number, z: number, angle: number): [number, number] {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return [y * c - z * s, y * s + z * c]
}

function rotateY(x: number, z: number, angle: number): [number, number] {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return [x * c + z * s, -x * s + z * c]
}


export function mobiusPoint(theta: number, width: number, radius = 1.88, halfWidth = 0.34): [number, number, number] {
  const twist = theta / 2
  const ring = radius + width * halfWidth * Math.cos(twist)
  return [
    ring * Math.cos(theta),
    ring * Math.sin(theta),
    width * halfWidth * Math.sin(twist),
  ]
}


function lemniscate(t: number): [number, number, number] {
  return [SCALE * Math.sin(t), SCALE * Math.sin(t) * Math.cos(t), 0]
}

function lemniscateTangent(t: number): [number, number, number] {
  return norm([Math.cos(t), Math.cos(2 * t), 0])
}


export function logoPoint(t: number, width: number, phase = 0): [number, number, number] {
  const [cx, cy, cz] = lemniscate(t)
  const tangent = lemniscateTangent(t)
  const binormal: [number, number, number] = [0, 0, 1]
  const normal = norm(cross(binormal, tangent))
  const twist = (t + phase) / 2
  const ox = normal[0] * Math.cos(twist) + binormal[0] * Math.sin(twist)
  const oy = normal[1] * Math.cos(twist) + binormal[1] * Math.sin(twist)
  const oz = normal[2] * Math.cos(twist) + binormal[2] * Math.sin(twist)
  const w = width * HALF_WIDTH
  return [cx + ox * w, cy + oy * w, cz + oz * w]
}

function logoNormal(t: number, phase: number): [number, number, number] {
  const tangent = lemniscateTangent(t)
  const binormal: [number, number, number] = [0, 0, 1]
  const normal = norm(cross(binormal, tangent))
  const twist = (t + phase) / 2
  return norm([
    normal[0] * Math.cos(twist) + binormal[0] * Math.sin(twist),
    normal[1] * Math.cos(twist) + binormal[1] * Math.sin(twist),
    normal[2] * Math.cos(twist) + binormal[2] * Math.sin(twist),
  ])
}

function transform(x: number, y: number, z: number, tilt: number, yaw: number): [number, number, number] {
  ;[y, z] = rotateX(y, z, tilt)
  ;[x, z] = rotateY(x, z, yaw)
  return [x, y, z]
}

function shadeChar(shade: number): string {
  return SHADE_RAMP[Math.round(clamp(shade, 0, 1) * (SHADE_RAMP.length - 1))] || '@'
}

export function renderMobiusFrame(options: MobiusFrameOptions = {}): string {
  const cols = Math.max(28, options.cols ?? 64)
  const rows = Math.max(10, options.rows ?? 16)
  const phase = options.phase ?? 0
  const color = options.color !== false
  const grid: Array<Array<Cell | null>> = Array.from({ length: rows }, () => Array(cols).fill(null))
  const tilt = 0.42
  const yaw = 0.18 * Math.sin(phase * 0.5)

  const thetaSteps = 520
  const scale = Math.min((cols - 2) / 4.15, (rows - 2) / (2.15 * CELL_ASPECT))

  for (let i = 0; i < thetaSteps; i += 1) {
    const theta = (i / thetaSteps) * Math.PI * 2
    for (let j = -4; j <= 4; j += 1) {
      const width = j / 4
      const base = logoPoint(theta, width, phase)
      const n0 = logoNormal(theta, phase)
      const thicks = j === -4 || j === 4 ? [-1, 0, 1] : [-1, 1]
      for (const thick of thicks) {
        let x = base[0] + n0[0] * thick * THICKNESS
        let y = base[1] + n0[1] * thick * THICKNESS
        let z = base[2] + n0[2] * thick * THICKNESS
        let nx = thick < 0 ? -n0[0] : n0[0]
        let ny = thick < 0 ? -n0[1] : n0[1]
        let nz = thick < 0 ? -n0[2] : n0[2]
        ;[x, y, z] = transform(x, y, z, tilt, yaw)
        ;[nx, ny, nz] = transform(nx, ny, nz, tilt, yaw)
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue

        let normal: [number, number, number] = [nx, ny, nz]
        const facing = dot(normal, VIEW)
        const back = facing < 0
        if (back) normal = [-normal[0], -normal[1], -normal[2]]

        const depth = CAM - z
        if (depth < 0.4 || !Number.isFinite(depth)) continue
        const px = (x * FOCAL) / depth
        const py = (y * FOCAL) / depth
        if (!Number.isFinite(px) || !Number.isFinite(py)) continue

        const lambert = Math.max(0, dot(normal, KEY))
        const fill = Math.max(0, dot(normal, FILL)) * 0.2
        const camFill = Math.max(0, dot(normal, VIEW)) * 0.2
        const half = norm([KEY[0] + VIEW[0], KEY[1] + VIEW[1], KEY[2] + VIEW[2]])
        const spec = Math.pow(Math.max(0, dot(normal, half)), 26)
        const edge = Math.abs(width)
        const rim = Math.pow(1 - Math.abs(dot(normal, VIEW)), 2.2) * (0.12 + 0.45 * edge * edge)
        const rider = Math.pow(Math.max(0, Math.cos(theta - phase)), 18)
        const ambient = back ? 0.1 : 0.2
        const lit = ambient + lambert * (back ? 0.32 : 0.7) + fill + camFill + spec * 0.45 + rim + rider * 0.55
        const shade = clamp(Math.pow(lit, 1.12), 0.07, 1)
        const fog = 0.5 + 0.5 * clamp(1 - (depth - 5.2) / 3.4, 0, 1)

        const col = Math.round(px * scale + (cols - 1) / 2)
        const row = Math.round(-py * scale * CELL_ASPECT + (rows - 1) / 2)
        if (col < 0 || col >= cols || row < 0 || row >= rows) continue
        const prev = grid[row][col]
        if (!prev || depth < prev.z) {
          grid[row][col] = {
            z: depth,
            shade: clamp(shade * fog, 0.06, 1),
            t: theta + phase,
            spec: (spec + rider) * fog,
          }
        }
      }
    }
  }

  return grid
    .map((line) =>
      line
        .map((cell) => {
          if (!cell) return ' '
          const ch = shadeChar(cell.shade)
          if (!color) return ch
          let [r, g, b] = mobiusRgb(cell.t)
          const lift = 0.2 + cell.shade * 0.92 + cell.spec * 0.55
          r = clamp(Number.isFinite(r * lift) ? Math.round(r * lift) : 180, 0, 255)
          g = clamp(Number.isFinite(g * lift) ? Math.round(g * lift) : 180, 0, 255)
          b = clamp(Number.isFinite(b * lift) ? Math.round(b * lift) : 180, 0, 255)
          return `${ansiRgb(r, g, b)}${ch}${RESET}`
        })
        .join(''),
    )
    .join('\n')
}

export function mobiusFrameHeight(columns = 80): number {
  return columns < 52 ? 11 : columns < 72 ? 15 : 18
}

export function mobiusFrameWidth(columns = 80): number {
  if (columns < 52) return Math.max(32, columns)
  if (columns < 72) return Math.min(60, columns)
  return Math.min(72, columns)
}
