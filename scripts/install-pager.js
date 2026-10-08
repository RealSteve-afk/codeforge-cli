#!/usr/bin/env node

const { execFileSync } = require('child_process')
const fs = require('fs')
const https = require('https')
const http = require('http')
const os = require('os')
const path = require('path')
const zlib = require('zlib')

const NPM_PAGER_PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64']
const SUPPORTED = new Set(NPM_PAGER_PLATFORMS)
const BIN = process.platform === 'win32' ? 'codeforge-pager.exe' : 'codeforge-pager'

function readVersion() {
  try {
    return require('../package.json').version
  } catch {
    return ''
  }
}

function codeforgeHome() {
  const override = (process.env.CODEFORGE_HOME || '').trim()
  if (override) return override
  return path.join(os.homedir(), '.codeforge')
}

function pagerBinDir() {
  return path.join(codeforgeHome(), 'bin')
}

function pagerBinPath() {
  return path.join(pagerBinDir(), BIN)
}

function pagerNpmName(key) {
  return `@realsteve-afk/codeforge-pager-${key}`
}

function pagerAssetName(key) {
  return `codeforge-pager-${key}.br`
}

function pagerPackageManifest(key, version) {
  const dash = key.indexOf('-')
  const osName = key.slice(0, dash)
  const cpu = key.slice(dash + 1)
  return {
    name: pagerNpmName(key),
    version,
    description: `CodeForge TUI pager (${key})`,
    license: 'MIT',
    os: [osName],
    cpu: [cpu],
    files: [pagerAssetName(key)],
    publishConfig: { access: 'public' },
  }
}

function windowsPagerKey(env = process.env, nodeArch = process.arch) {
  const wow64 = String(env.PROCESSOR_ARCHITEW6432 || '')
  const native = String(env.PROCESSOR_ARCHITECTURE || '')
  const osArch = wow64 || native
  if (/AMD64/i.test(osArch) || /AMD64/i.test(wow64) || nodeArch === 'x64') {
    return 'win32-x64'
  }
  if (/ARM64/i.test(osArch) && nodeArch === 'arm64' && !wow64) {
    return 'win32-arm64'
  }
  if (/ARM64/i.test(osArch) || /ARM64/i.test(wow64)) {
    return 'win32-x64'
  }
  return 'win32-ia32'
}

function platformKey(env = process.env, nodeArch = process.arch, nodePlatform = process.platform) {
  if (nodePlatform === 'win32') return windowsPagerKey(env, nodeArch)
  return `${nodePlatform}-${nodeArch}`
}

function npmRegistry(options = {}) {
  const raw = options.registry || process.env.npm_config_registry || 'https://registry.npmjs.org'
  return String(raw).replace(/\/+$/, '')
}

function pagerTarballUrl(key, version, options = {}) {
  const name = pagerNpmName(key)
  const encoded = name.replace('/', '%2f')
  const file = `codeforge-pager-${key}-${version}.tgz`
  return `${npmRegistry(options)}/${encoded}/-/${file}`
}

function releaseAssetUrl(version, key) {
  return `https://github.com/RealSteve-afk/codeforge-cli/releases/download/v${version}/${pagerAssetName(key)}`
}

function pagerUnavailableReason(key, version) {
  const ver = version ? ` (v${version})` : ''
  return `no CodeForge TUI pager for ${key}${ver}; reinstall with a 64-bit Node or run codeforge update`
}

function isSourceCheckout() {
  return fs.existsSync(path.join(__dirname, '..', '.git'))
}

function findPagerPackage(key) {
  const name = pagerNpmName(key)
  try {
    return path.dirname(require.resolve(`${name}/package.json`))
  } catch {
    
  }
  const scoped = name.split('/')
  const candidates = [
    path.join(__dirname, '..', 'node_modules', ...scoped),
    path.join(__dirname, '..', '..', scoped[1]),
  ]
  const asset = pagerAssetName(key)
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, asset))) return dir
  }
  return null
}

function pagerStampPath(dest) {
  return `${dest}.version`
}

function installedPagerVersion(dest) {
  try {
    return fs.readFileSync(pagerStampPath(dest), 'utf8').trim()
  } catch {
    return ''
  }
}

function writeBinary(bytes, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 })
  const tmp = `${dest}.tmp.${process.pid}`
  fs.writeFileSync(tmp, bytes)
  if (process.platform !== 'win32') fs.chmodSync(tmp, 0o755)
  fs.renameSync(tmp, dest)
}

function writePagerStamp(dest, version) {
  if (!version) return
  fs.writeFileSync(pagerStampPath(dest), `${version}\n`, { encoding: 'utf8', mode: 0o644 })
}

function decodePayload(buf) {
  try {
    return zlib.brotliDecompressSync(buf)
  } catch {
    return buf
  }
}

function download(url) {
  const client = url.startsWith('http://') ? http : https
  return new Promise((resolve, reject) => {
    const req = client.get(url, { headers: { 'User-Agent': 'codeforge-cli' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        download(res.headers.location).then(resolve, reject)
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`download ${url} failed (${res.statusCode})`))
        return
      }
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(120_000, () => {
      req.destroy(new Error('download timed out'))
    })
  })
}

function extractBrFromTarball(tgzPath, key) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-pager-npm-'))
  try {
    execFileSync('tar', ['-xzf', tgzPath, '-C', tmp], { stdio: 'ignore' })
    const want = pagerAssetName(key)
    const stack = [tmp]
    while (stack.length) {
      const dir = stack.pop()
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name)
        if (fs.statSync(full).isDirectory()) stack.push(full)
        else if (name === want) return fs.readFileSync(full)
      }
    }
    throw new Error(`tarball missing ${want}`)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

function unpackBrFile(brPath, dest, version) {
  const payload = fs.readFileSync(brPath)
  writeBinary(decodePayload(payload), dest)
  writePagerStamp(dest, version)
}

async function installFromRegistry(key, version, dest, options) {
  const url = pagerTarballUrl(key, version, options)
  process.stdout.write(`codeforge: downloading TUI pager ${pagerNpmName(key)}@${version}\n`)
  const tgzPath = path.join(
    os.tmpdir(),
    `codeforge-pager-${key}-${process.pid}.tgz`,
  )
  const body = await download(url)
  fs.writeFileSync(tgzPath, body)
  try {
    const br = extractBrFromTarball(tgzPath, key)
    writeBinary(decodePayload(br), dest)
    writePagerStamp(dest, version)
    return { ok: true, dest, url }
  } finally {
    try {
      fs.unlinkSync(tgzPath)
    } catch {
          }
  }
}

async function installPager(options = {}) {
  if (process.env.CODEFORGE_SKIP_PAGER === '1') {
    return { ok: true, skipped: true, reason: 'CODEFORGE_SKIP_PAGER' }
  }
  const key = options.platform || platformKey(options.env, options.nodeArch, options.nodePlatform)
  const version = options.version || readVersion()
  const dest = options.dest || pagerBinPath()
  if (!SUPPORTED.has(key) || !NPM_PAGER_PLATFORMS.includes(key)) {
    return { ok: false, skipped: false, reason: pagerUnavailableReason(key, version) }
  }
  const have = fs.existsSync(dest)
  const stamped = have ? installedPagerVersion(dest) : ''
  if (!options.force && have && version && stamped === version) {
    return { ok: true, dest, skipped: true, reason: 'already installed' }
  }
  if (options.file) {
    unpackBrFile(options.file, dest, version)
    return { ok: true, dest }
  }
  const pkgDir = options.packageDir || findPagerPackage(key)
  if (pkgDir) {
    const brPath = path.join(pkgDir, pagerAssetName(key))
    if (!fs.existsSync(brPath)) {
      return { ok: false, skipped: false, reason: `pager package missing ${pagerAssetName(key)}` }
    }
    process.stdout.write(`codeforge: installing TUI pager from ${pagerNpmName(key)}\n`)
    unpackBrFile(brPath, dest, version)
    return { ok: true, dest, packageDir: pkgDir }
  }
  try {
    return await installFromRegistry(key, version, dest, options)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (isSourceCheckout() && !options.forceRegistry) {
      return { ok: true, skipped: true, reason: `source checkout (${message})` }
    }
    return {
      ok: false,
      skipped: false,
      reason: `pager package ${pagerNpmName(key)}@${version} is not installed (${message})`,
      url: pagerTarballUrl(key, version, options),
    }
  }
}

module.exports = {
  NPM_PAGER_PLATFORMS,
  SUPPORTED,
  decodePayload,
  findPagerPackage,
  installPager,
  installedPagerVersion,
  pagerAssetName,
  pagerBinPath,
  pagerNpmName,
  pagerPackageManifest,
  pagerStampPath,
  pagerTarballUrl,
  pagerUnavailableReason,
  platformKey,
  releaseAssetUrl,
  windowsPagerKey,
  writeBinary,
  writePagerStamp,
}

if (require.main === module) {
  installPager({ force: process.argv.includes('--force') }).then(
    (result) => {
      if (result.ok) {
        if (!result.skipped) process.stdout.write(`installed CodeForge pager to ${result.dest}\n`)
        process.exit(0)
      }
      process.stderr.write(`codeforge pager: ${result.reason}\n`)
      process.exit(1)
    },
    (error) => {
      process.stderr.write(`codeforge pager: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    },
  )
}
