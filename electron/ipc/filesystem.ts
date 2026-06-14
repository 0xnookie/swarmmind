import { ipcMain } from 'electron'
import { readdir, readFile, writeFile } from 'fs/promises'
import { existsSync, statSync } from 'fs'
import { join, extname } from 'path'

export interface FsEntry {
  name: string
  path: string
  type: 'file' | 'dir'
  ext: string  // lowercase extension without dot, e.g. 'ts', '' for dirs
}

export function registerFsHandlers(): void {
  // List directory contents — dirs first, then files, both alphabetical
  // Hidden entries (starting with '.') are included but flagged
  ipcMain.handle('fs:listDir', async (_e, dirPath: string): Promise<FsEntry[]> => {
    if (!existsSync(dirPath)) return []
    try {
      const entries = await readdir(dirPath, { withFileTypes: true })
      const result: FsEntry[] = entries
        .filter(e => e.isFile() || e.isDirectory())
        .map((e): FsEntry => ({
          name: e.name,
          path: join(dirPath, e.name),
          type: e.isDirectory() ? 'dir' : 'file',
          ext: e.isDirectory() ? '' : extname(e.name).slice(1).toLowerCase(),
        }))
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
          return a.name.localeCompare(b.name)
        })
      return result
    } catch {
      return []
    }
  })

  // Read a text file (max 5MB)
  ipcMain.handle('fs:readFile', async (_e, filePath: string): Promise<string> => {
    const stat = statSync(filePath, { throwIfNoEntry: false })
    if (!stat || !stat.isFile() || stat.size > 5 * 1024 * 1024) {
      throw new Error('File not found or too large')
    }
    const buf = await readFile(filePath)
    return buf.toString('utf-8')
  })

  // Write a text file
  ipcMain.handle('fs:writeFile', async (_e, filePath: string, content: string): Promise<void> => {
    await writeFile(filePath, content, 'utf-8')
  })

  // Read an image file as a base64 data URL plus metadata (max 25MB)
  ipcMain.handle('fs:readImage', async (_e, filePath: string): Promise<ImageData> => {
    const stat = statSync(filePath, { throwIfNoEntry: false })
    if (!stat || !stat.isFile() || stat.size > 25 * 1024 * 1024) {
      throw new Error('Image not found or too large')
    }
    const mime = imageMime(extname(filePath).slice(1).toLowerCase())
    if (!mime) throw new Error('Unsupported image type')
    const buf = await readFile(filePath)
    return {
      dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
      mime,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    }
  })
}

export interface ImageData {
  dataUrl: string
  mime: string
  size: number
  mtimeMs: number
}

function imageMime(ext: string): string | null {
  switch (ext) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'gif':
      return 'image/gif'
    case 'webp':
      return 'image/webp'
    case 'bmp':
      return 'image/bmp'
    case 'ico':
      return 'image/x-icon'
    case 'avif':
      return 'image/avif'
    default:
      return null
  }
}
