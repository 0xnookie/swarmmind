import { ipcMain, app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'

// ── Persistent Whisper model cache ──────────────────────────────────────────────
// SwarmVoice's Whisper model (~tens of MB) is fetched once from HuggingFace by
// @xenova/transformers. In the browser that library caches files in the Cache API
// ('transformers-cache'), but in a packaged build the renderer runs from a
// `file://` origin where the Cache API is NOT persisted to disk — so the model
// re-downloaded on every launch. We instead back transformers' cache with a real
// directory under userData via `env.useCustomCache`, which survives restarts
// regardless of the renderer's origin. Keyed by the remote URL transformers asks
// for (hashed to a safe filename); the response headers are stored alongside so
// the reconstructed Response carries content-length etc.

function cacheDir(): string {
  return join(app.getPath('userData'), 'voice-model-cache')
}

function pathsFor(key: string): { bin: string; meta: string } {
  const h = createHash('sha256').update(key).digest('hex')
  return { bin: join(cacheDir(), `${h}.bin`), meta: join(cacheDir(), `${h}.json`) }
}

interface CacheMeta {
  headers: Record<string, string>
  size: number
}

export function registerVoiceCacheHandlers(): void {
  // Return a cached file's bytes + headers, or null on miss. We validate the
  // on-disk size against the stored size so a truncated/corrupt entry counts as
  // a miss (forcing a clean re-download) rather than feeding a broken model in.
  ipcMain.handle('voiceCache:match', async (_e, key: string) => {
    try {
      const { bin, meta } = pathsFor(key)
      const data = await fs.readFile(bin)
      let parsed: CacheMeta | null = null
      try { parsed = JSON.parse(await fs.readFile(meta, 'utf-8')) as CacheMeta } catch { /* headers optional */ }
      if (parsed && typeof parsed.size === 'number' && parsed.size !== data.byteLength) {
        console.warn(`[voiceCache] size mismatch for ${key} — treating as miss`)
        return null // partial / corrupt — treat as a miss
      }
      console.debug(`[voiceCache] hit: ${key} (${data.byteLength} bytes)`)
      // Hand back a standalone ArrayBuffer (structured-clone friendly).
      const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
      return { data: ab, headers: parsed?.headers ?? {} }
    } catch {
      return null
    }
  })

  // Persist a downloaded file. Written to a temp path then renamed so a crash
  // mid-write can never leave a half-written model file behind.
  ipcMain.handle('voiceCache:put', async (_e, key: string, data: ArrayBuffer, headers: Record<string, string>) => {
    try {
      await fs.mkdir(cacheDir(), { recursive: true })
      const { bin, meta } = pathsFor(key)
      const buf = Buffer.from(data)
      const tmp = `${bin}.${process.pid}.tmp`
      await fs.writeFile(tmp, buf)
      await fs.rename(tmp, bin)
      const m: CacheMeta = { headers: headers ?? {}, size: buf.byteLength }
      await fs.writeFile(meta, JSON.stringify(m))
      console.debug(`[voiceCache] put: ${key} (${buf.byteLength} bytes)`)
      return true
    } catch (err) {
      console.warn('[voiceCache] put failed:', err)
      return false
    }
  })
}
