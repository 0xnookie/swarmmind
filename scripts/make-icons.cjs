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
 * sharp can't emit .ico, so we assemble one by hand: modern Windows accepts
 * PNG-encoded entries inside an ICO container, so each size is just a PNG blob
 * referenced from the icon directory.
 */
const sharp = require('sharp')
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

  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)            // reserved
  header.writeUInt16LE(1, 2)            // type: 1 = icon
  header.writeUInt16LE(pngs.length, 4)  // image count

  const dir = Buffer.alloc(16 * pngs.length)
  let offset = header.length + dir.length
  pngs.forEach((png, i) => {
    const size = ICO_SIZES[i]
    const e = i * 16
    dir.writeUInt8(size >= 256 ? 0 : size, e + 0)   // width (0 ⇒ 256)
    dir.writeUInt8(size >= 256 ? 0 : size, e + 1)   // height (0 ⇒ 256)
    dir.writeUInt8(0, e + 2)                         // palette colours
    dir.writeUInt8(0, e + 3)                         // reserved
    dir.writeUInt16LE(1, e + 4)                      // colour planes
    dir.writeUInt16LE(32, e + 6)                     // bits per pixel
    dir.writeUInt32LE(png.length, e + 8)             // bytes in resource
    dir.writeUInt32LE(offset, e + 12)                // offset to data
    offset += png.length
  })

  return Buffer.concat([header, dir, ...pngs])
}

async function main() {
  mkdirSync(join(root, 'resources', 'icons'), { recursive: true })
  mkdirSync(join(root, 'src', 'assets'), { recursive: true })

  await sharp(source).resize(1024, 1024, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toFile(join(root, 'resources', 'icon.png'))

  await sharp(source).resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toFile(join(root, 'src', 'assets', 'logo.png'))

  writeFileSync(join(root, 'resources', 'icons', 'icon.ico'), await buildIco(source))

  console.log('Icons generated from', source)
}

main().catch(err => { console.error(err); process.exit(1) })
