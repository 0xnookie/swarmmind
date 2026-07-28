// Verification for the SwarmVoice wake word.
//
// **What this can and cannot prove.** Recognition needs a microphone and real
// speech; the environment has neither, so the *matching* half — everything that
// decides whether a transcript counts as the wake phrase — is unit-tested
// against `src/lib/wakeWord.ts` instead (punctuation, mishearings, mid-sentence
// mentions, the command spoken in the same breath). What no unit test can see,
// and what this covers, is the half that only exists in a running app: that
// arming actually opens the microphone, that the UI says so, and — most
// importantly — that turning it off *releases* the mic.
//
// That last one is the reason this file exists. A hands-free feature that leaves
// the microphone open after being switched off is the worst bug this could have,
// and it's invisible from the code: the tracks are held by a closure inside an
// effect. Here it's checked by counting live tracks in the page.
//
// Chromium's fake audio device stands in for the mic (`--use-fake-device-for-
// media-stream`), so `getUserMedia` resolves without hardware or a permission
// prompt. It produces a tone rather than speech, which is exactly enough to
// drive the mic lifecycle and nothing more.
//
// The Settings modal is opened once and left open: everything under test is
// driven from it, and the wake listener doesn't care what's on screen. Closing
// and reopening it between steps only added click-interception flakiness.
//
// Run after `npm run build`:  node tests/wakeword-verify.mjs
import { _electron as electron } from 'playwright-core'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const mainEntry = join(root, 'out', 'main', 'index.js')
const userDataDir = mkdtempSync(join(tmpdir(), 'swarmmind-wakeverify-'))
const wsDir = mkdtempSync(join(tmpdir(), 'swarmmind-wakews-'))

const hardTimeout = setTimeout(() => { console.error('[wakeverify] TIMEOUT'); process.exit(1) }, 240_000)
hardTimeout.unref()

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

const VOICE_BTN = 'button[aria-label="Toggle dictation widget"]'
const WAKE_TOGGLE = 'button[role="switch"][aria-label="Wake word"]'

let fatal = null
const app = await electron.launch({
  args: [
    mainEntry,
    `--user-data-dir=${userDataDir}`,
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
  ],
})
try {
  const win = await app.firstWindow({ timeout: 30_000 })
  win.on('pageerror', (err) => console.log('[renderer pageerror]', err.message))
  await win.waitForLoadState('domcontentloaded')
  await win.waitForSelector('#root *', { state: 'attached', timeout: 30_000 })
  await win.evaluate((p) => window.swarmmind.workspaceOpenByPath(p, 'wakeverify'), wsDir)
  await win.reload()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForSelector(VOICE_BTN, { timeout: 30_000 })

  // Count microphone tracks the page is actually holding open. Wrapping
  // getUserMedia is the only way to see them — nothing else exposes the streams.
  await win.evaluate(() => {
    window.__micTracks = []
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    navigator.mediaDevices.getUserMedia = async (c) => {
      const s = await real(c)
      window.__micTracks.push(...s.getTracks())
      return s
    }
  })
  const liveTracks = () =>
    win.evaluate(() => (window.__micTracks ?? []).filter((t) => t.readyState === 'live').length)
  const waitForTracks = async (want, seconds) => {
    for (let i = 0; i < seconds; i++) {
      if ((await liveTracks()) === want) return true
      await win.waitForTimeout(1000)
    }
    return (await liveTracks()) === want
  }

  check('nothing holds the mic before the wake word is enabled', (await liveTracks()) === 0)

  // Open Settings once and drive everything from there, so the toggle, the
  // draft/save wiring and the listener are exercised together.
  await win.click('button[aria-label="Settings"]')
  const toggle = win.locator(WAKE_TOGGLE)
  await toggle.waitFor({ timeout: 15_000 })
  const save = async () => {
    const btn = win.locator('button', { hasText: /^(Save|Saving|✓ Saved)$/ }).last()
    if (await btn.isEnabled()) await btn.click()
    await win.waitForTimeout(500)
  }

  check('the wake word ships off by default', (await toggle.getAttribute('aria-checked')) === 'false')

  // ── Arming ────────────────────────────────────────────────────────────────
  await toggle.click()
  check('turning it on reveals the phrase field', await win.locator('#voice-wake-phrase').count() === 1)
  await save()

  // The Whisper model has to load before the listener opens the mic, and on a
  // cold profile that's a real download — give it room.
  const armed = await waitForTracks(1, 150)
  check('enabling the wake word opens the microphone', armed, `live tracks: ${await liveTracks()}`)

  // ── The UI has to admit the mic is open ───────────────────────────────────
  const tooltip = await win.getAttribute(VOICE_BTN, 'title')
  check(
    'the TopBar tooltip names the phrase it is listening for',
    /listening for/i.test(tooltip ?? '') && /hey swarm/i.test(tooltip ?? ''),
    JSON.stringify((tooltip ?? '').split('\n').pop())
  )

  // A hands-free mic must be visible without opening anything.
  const dot = await win.evaluate(() => {
    const btn = document.querySelector('button[aria-label="Toggle dictation widget"]')
    return [...(btn?.querySelectorAll('span') ?? [])].some((s) => {
      const cs = getComputedStyle(s)
      return cs.position === 'absolute' && parseFloat(cs.width) > 0 && cs.borderRadius === '50%'
    })
  })
  check('an armed indicator is visible on the TopBar', dot)

  // ── A phrase too short to be reliable ─────────────────────────────────────
  // It must be refused visibly. Silently reverting it on save would leave the
  // user saying a phrase that can never fire, with nothing explaining why.
  const phraseInput = win.locator('#voice-wake-phrase')
  await phraseInput.fill('hey')
  await win.waitForTimeout(300)
  const warned = await win.evaluate(() =>
    [...document.querySelectorAll('p')].some((p) => /too short to be a reliable/i.test(p.textContent || ''))
  )
  check('the UI warns about a too-short phrase', warned)
  await save()
  const afterJunk = await win.evaluate(() => window.swarmmind.getAppSetting('voiceWakePhrase'))
  check('a too-short phrase is never persisted', afterJunk !== 'hey', JSON.stringify(afterJunk))

  // A real custom phrase does stick.
  await phraseInput.fill('ok computer')
  await save()
  const custom = await win.evaluate(() => window.swarmmind.getAppSetting('voiceWakePhrase'))
  check('a valid custom phrase is persisted', custom === 'ok computer', JSON.stringify(custom))

  await win.screenshot({ path: join(root, 'tests', 'wakeword-verify.png') })

  // ── Releasing ─────────────────────────────────────────────────────────────
  // The one that matters: switching it off must not leave the mic open.
  await toggle.click()
  await save()
  const released = await waitForTracks(0, 20)
  check('disabling the wake word releases the microphone', released, `live tracks: ${await liveTracks()}`)

  const persisted = await win.evaluate(() => window.swarmmind.getAppSetting('voiceWakeEnabled'))
  check('the off state is persisted', persisted === '0', JSON.stringify(persisted))

  // ── Mic contention ────────────────────────────────────────────────────────
  // Runs last, and re-arms first: it deliberately leaves dictation recording,
  // which would otherwise be the live track the release check above sees.
  await toggle.click()
  await save()
  await waitForTracks(1, 60)

  // The subtlest part of the design: dictation and the wake listener must never
  // hold the microphone at the same time. If they did, the listener would hear
  // the user's own dictation and could re-trigger off it. Start dictation while
  // armed and watch the live-track count — it must never reach two.
  await win.keyboard.press('Control+Shift+M')
  //
  // NB this drives dictation from the *keyboard shortcut*, not from a wake —
  // firing the wake word needs real speech, which this environment can't
  // produce. So it covers the manual-dictation-while-armed path: the listener
  // must release before dictation acquires. The wake→dictation hand-off (where
  // dictation adopts the listener's live stream instead of acquiring a new one)
  // is *not* covered here and has no automated test.
  let peak = 0
  let tookOver = false
  for (let i = 0; i < 24; i++) {
    const live = await liveTracks()
    if (live > peak) peak = live
    const total = await win.evaluate(() => (window.__micTracks ?? []).length)
    if (total > 1 && live === 1) tookOver = true
    await win.waitForTimeout(250)
  }
  check('dictation and the wake listener never hold the mic at once', peak <= 1, `peak live tracks: ${peak}`)
  console.log(`[wakeverify] dictation acquired its own stream after the listener released: ${tookOver}`)

  console.log('[wakeverify] screenshot -> tests/wakeword-verify.png')
} catch (err) {
  fatal = err instanceof Error ? err.stack ?? err.message : String(err)
} finally {
  await app.close().catch(() => {})
  clearTimeout(hardTimeout)
}

if (fatal) { console.error('[wakeverify] ERROR:', fatal); process.exit(1) }
console.log(failures === 0 ? '\n[wakeverify] PASS' : `\n[wakeverify] ${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
