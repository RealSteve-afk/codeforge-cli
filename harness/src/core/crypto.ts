import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

// Passwords: scrypt with a per-user salt. Stored as "scrypt$<salt-hex>$<hash-hex>".
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(password, salt, 64)
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split('$')
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false
  const expected = Buffer.from(hashHex, 'hex')
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length)
  return crypto.timingSafeEqual(expected, actual)
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url')
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

// Provider API keys are encrypted at rest with AES-256-GCM. The 32-byte master
// key comes from HARNESS_MASTER_KEY (base64) or a 0600 file in the data dir.
export function loadMasterKey(dataDir: string): Buffer {
  const fromEnv = process.env.HARNESS_MASTER_KEY
  if (fromEnv) {
    const key = Buffer.from(fromEnv, 'base64')
    if (key.length !== 32) throw new Error('HARNESS_MASTER_KEY must be 32 bytes, base64-encoded')
    return key
  }
  const file = path.join(dataDir, 'master.key')
  if (fs.existsSync(file)) return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64')
  const key = crypto.randomBytes(32)
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, `${key.toString('base64')}\n`, { mode: 0o600 })
  return key
}

export function encryptSecret(plain: string, key: Buffer): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${body.toString('base64')}`
}

export function decryptSecret(sealed: string, key: Buffer): string {
  const [version, ivB64, tagB64, bodyB64] = sealed.split(':')
  if (version !== 'v1' || !ivB64 || !tagB64 || bodyB64 === undefined) throw new Error('unrecognized secret format')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(bodyB64, 'base64')), decipher.final()]).toString('utf8')
}
