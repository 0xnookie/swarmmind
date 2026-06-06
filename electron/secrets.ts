import { safeStorage } from 'electron'

// Stored-secret format: encrypted values are prefixed so we can distinguish them
// from legacy plaintext values written before encryption existed. Anything
// without the prefix is returned as-is (back-compat) and gets re-encrypted the
// next time it's written.
const PREFIX = 'enc:v1:'

// Encrypt a secret for at-rest storage. Falls back to returning the plaintext
// unchanged if the OS keychain isn't available (e.g. a headless Linux box
// without a configured backend) — better than failing to save the config.
export function encryptSecret(plain: string): string {
  if (!plain) return plain
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return PREFIX + safeStorage.encryptString(plain).toString('base64')
    }
  } catch { /* fall through to plaintext */ }
  return plain
}

// Decrypt a stored secret. Returns legacy/plaintext values unchanged.
export function decryptSecret(stored: string): string {
  if (!stored || !stored.startsWith(PREFIX)) return stored
  try {
    const buf = Buffer.from(stored.slice(PREFIX.length), 'base64')
    return safeStorage.decryptString(buf)
  } catch {
    // Wrong machine / corrupted blob — surface empty rather than a garbled key.
    return ''
  }
}
