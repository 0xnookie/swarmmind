#!/usr/bin/env node
/*
 * Regenerate every app-icon asset from a single source PNG.
 *
 *   node scripts/make-icons.cjs [sourcePng]
 *
 * Defaults to resources/icon-source.png. Produces:
 *   resources/icon.png          1024² — electron-builder base (mac/linux, win fallback)
 *   resources/icons/icon.ico    multi-size ICO (16…256) for win.icon / BrowserWindow
 *   src/assets/logo.png         512²  — in-app brand mark (TopBar)
 *
 * We ship a hybrid ICO — the most broadly compatible form on Windows:
 *   - sizes <256 as classic BMP entries: the shell (desktop shortcut,
 *     taskbar) renders these reliably, whereas a PNG-only ICO can fall back
 *     to the default icon at 16/32/48 px.
 *   - 256 as a PNG-compressed entry: Vista+ expects the 256px slot to be PNG;
 *     a raw 256² BMP (~256 KB) can make the shell reject the whole icon group
 *     and show the default icon for every size.
 *
 * to-ico packs every size as BMP, so we let it build the container, then swap
 * the 256px payload for a PNG and rebuild the directory + offsets.
 */
const sharp = require('sharp')
const toIco = require('to-ico')
const { mkdirSync, writeFileSync } = require('fs')
const { join, resolve } = require('path')

const root = resolve(__dirname, '..')
const source = process.argv[2] || join(root, 'resources', 'icon-source.png')

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

async function buildIco(src) {
  const pngs = await Promise.all(
    ICO_SIZES.map(size =>
      sharp(src).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer()
    )
  )
  const ico = await toIco(pngs)
  return repack256AsPng(ico, pngs[ICO_SIZES.indexOf(256)])
}

// Rewrite the 256x256 entry of a to-ico container so its payload is the PNG
// blob instead of a raw BMP, then rebuild the directory with fresh offsets.
// Small entries are copied through untouched (their BMP form is what the
// shell wants); only the 256 slot and all data offsets change.
function repack256AsPng(ico, png256) {
  const count = ico.readUInt16LE(4)
  const entries = []
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16
    const width = ico[e] === 0 ? 256 : ico[e]   // width byte 0 ⇒ 256
    const dir = Buffer.from(ico.subarray(e, e + 16))
    let data = ico.subarray(ico.readUInt32LE(e + 12), ico.readUInt32LE(e + 12) + ico.readUInt32LE(e + 8))
    if (width === 256) {
      data = png256
      dir.writeUInt8(0, 0)            // width  (0 ⇒ 256)
      dir.writeUInt8(0, 1)            // height (0 ⇒ 256)
      dir.writeUInt8(0, 2)            // palette colours
      dir.writeUInt16LE(1, 4)         // colour planes
      dir.writeUInt16LE(32, 6)        // bits per pixel
    }
    entries.push({ dir, data })
  }

  const header = Buffer.alloc(6)
  header.writeUInt16LE(1, 2)          // type: 1 = icon
  header.writeUInt16LE(count, 4)

  let offset = 6 + count * 16
  const dirs = []
  const datas = []
  for (const { dir, data } of entries) {
    dir.writeUInt32LE(data.length, 8)   // bytes in resource
    dir.writeUInt32LE(offset, 12)       // offset to data
    dirs.push(dir)
    datas.push(data)
    offset += data.length
  }
  return Buffer.concat([header, ...dirs, ...datas])
}

async function main() {
  mkdirSync(join(root, 'resources', 'icons'), { recursive: true })
  mkdirSync(join(root, 'src', 'assets'), { recursive: true })
  // electron-builder discovers the *app* icon (the one baked into the .exe and
  // the mac/linux bundles) only by convention — it scans build/ and the project
  // root for icon.ico / icon.png / icon.icns and IGNORES win.icon for this step.
  // So the canonical icons must live in build/, or every platform ships the
  // default Electron icon regardless of win.icon / installerIcon.
  mkdirSync(join(root, 'build'), { recursive: true })

  const png1024 = await sharp(source)
    .resize(1024, 1024, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toBuffer()

  writeFileSync(join(root, 'resources', 'icon.png'), png1024)
  writeFileSync(join(root, 'build', 'icon.png'), png1024)        // linux/mac app icon (electron-builder convention)

  await sharp(source).resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toFile(join(root, 'src', 'assets', 'logo.png'))

  const ico = await buildIco(source)
  writeFileSync(join(root, 'resources', 'icons', 'icon.ico'), ico)
  writeFileSync(join(root, 'build', 'icon.ico'), ico)            // windows app icon (electron-builder convention)

  console.log('Icons generated from', source)
}

main().catch(err => { console.error(err); process.exit(1) })
