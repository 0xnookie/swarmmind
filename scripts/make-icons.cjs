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
 * to-ico assembles the container: it stores small sizes (<256) as classic
 * BMP entries and 256 as PNG. This matters on Windows — the shell (desktop
 * shortcut, taskbar) renders the small BMP entries reliably, whereas a
 * PNG-only ICO can fall back to the default icon at 16/32/48 px.
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
  return toIco(pngs)
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
