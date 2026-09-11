// Claude-code PPT verification: fresh launch (home visible) → create PPT →
// 1 AI round. The Excel 20 rounds are validated in claude-code-goal.cjs; this
// isolates the PPT creation (the home quick-card isn't clickable after a doc
// opens, so we use a fresh launch + a text-based slides card pick).
// Run: node e2e/claude-code-ppt-smoke.cjs
const { _electron: electron } = require('@playwright/test')
const { mkdtemp, writeFile, mkdir, appendFile } = require('node:fs/promises')
const { existsSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { createRequire } = require('node:module')

const SHELL_DIR = resolve(__dirname, '../apps/shell')
const SHELL_MAIN = join(SHELL_DIR, 'out/main/index.js')
const SHOTS = resolve(__dirname, 'artifacts/claude-code-ppt')
const LOG = join(SHOTS, 'run.log')
const log = async (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
  console.log(line)
  await appendFile(LOG, line + '\n').catch(() => undefined)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  await mkdir(SHOTS, { recursive: true })
  await writeFile(LOG, '')
  if (!existsSync(SHELL_MAIN)) throw new Error('Shell main not built: ' + SHELL_MAIN)
  const userDataDir = await mkdtemp(join(tmpdir(), 'genoffice-ppt-'))
  await writeFile(join(userDataDir, 'app-settings.json'), JSON.stringify({ onboardingSeen: true }))
  await writeFile(
    join(userDataDir, 'ai-settings.json'),
    JSON.stringify({
      provider: 'claude-code',
      providers: { 'claude-code': { apiKey: '', model: 'claude-sonnet-5', cliPath: undefined } },
      gskToolsEnabled: true,
    }),
  )
  const req = createRequire(join(SHELL_DIR, 'package.json'))
  const executablePath = req('electron')
  const { ELECTRON_RUN_AS_NODE: _drop, ...hostEnv } = process.env
  await log('ppt: launching dev shell…')
  const app = await electron.launch({
    executablePath,
    args: [SHELL_DIR],
    env: {
      ...hostEnv,
      GENOFFICE_USER_DATA: userDataDir,
      GENOFFICE_LANG: 'en',
      ELECTRON_RENDERER_URL: 'http://localhost:5199',
      DOCS_RENDERER_URL: 'http://localhost:5173',
      SHEETS_RENDERER_URL: 'http://localhost:5174',
      SLIDES_RENDERER_URL: 'http://localhost:5175',
      PDF_RENDERER_URL: 'http://localhost:5176',
      MARKDOWN_RENDERER_URL: 'http://localhost:5177',
      HTML_RENDERER_URL: 'http://localhost:5178',
    },
  })
  app.process().stderr?.on('data', (d) => {
    const s = d.toString()
    if (/cc-mcp|claude-agent-acp|session\/|tool-exec|error|timed out/i.test(s))
      appendFile(LOG, '[main:stderr] ' + s.trim() + '\n').catch(() => undefined)
  })
  try {
    const home = await app.firstWindow()
    await home.waitForFunction(
      () => document.readyState !== 'loading' && location.href !== 'about:blank',
      null,
      { timeout: 30000 },
    ).catch(() => {})
    await wait(1500)
    await home.screenshot({ path: join(SHOTS, '01-home.png') })
    // pick the slides quick-card by text (robust to card reordering)
    const slidesCard = home.locator('.quick-card', { hasText: /slide|ppt/i }).first()
    if (await slidesCard.count()) {
      await slidesCard.click()
      await log('ppt: clicked slides quick-card')
    } else {
      // fallback: nth(2) (docs/sheets/slides order)
      await home.locator('.quick-card').nth(2).click()
      await log('ppt: clicked nth(2) quick-card (fallback)')
    }
    // wait for the slides renderer
    let slides = null
    const deadline = Date.now() + 30000
    while (Date.now() < deadline && !slides) {
      for (const w of app.windows()) {
        if (w.url().includes(':5175')) { slides = w; break }
        const href = await w.evaluate(() => location.href).catch(() => '')
        if (href.includes(':5175')) { slides = w; break }
      }
      if (!slides) await app.waitForEvent('window', { timeout: 1000 }).catch(() => {})
    }
    if (!slides) throw new Error('slides window never opened; windows=' + app.windows().map((w) => w.url()))
    await slides.waitForTimeout(2000)
    await slides.screenshot({ path: join(SHOTS, '02-slides.png') })
    await log('ppt: slides ready:', slides.url())
    // probe the slides DOM to find the AI panel toggle + composer
    const probe = await slides.evaluate(() => {
      const buttons = [...document.querySelectorAll('button')].map((b) => ({
        t: (b.textContent || '').trim().slice(0, 20),
        al: b.getAttribute('aria-label'),
        cls: (b.className || '').slice(0, 40),
      }))
      const tas = [...document.querySelectorAll('textarea')].map((t) => ({
        al: t.getAttribute('aria-label'),
        ph: t.placeholder,
        cls: (t.className || '').slice(0, 40),
      }))
      return { nButtons: buttons.length, buttons: buttons.filter((b) => b.t || b.al).slice(0, 50), textareas: tas }
    })
    await log('ppt: slides probe:', probe)
    // send one round (slides composer: textarea placeholder "Describe the deck…",
    // Send button class ai-send-btn — no aria-label like sheets)
    const ta = slides.locator('textarea[placeholder*="Describe the deck"]')
    if (await ta.count()) {
      await ta.fill('Use the apply_ops tool (NOT generate_deck) to add one new slide containing a title text box with the text "Q3 Report". Then on the same slide add a content text box with two bullet lines: "Revenue up 20%" and "Expenses flat".')
      await wait(200)
      const send = slides.locator('button.ai-send-btn')
      if (await send.count()) await send.first().click()
      else await ta.press('Enter')
      await log('ppt: prompt sent; waiting for response…')
      const done = await (async () => {
        const t0 = Date.now()
        while (Date.now() - t0 < 150000) {
          const r = await slides
            .evaluate(() => {
              const t = document.body.textContent || ''
              return /AI finished|AI stopped|Retry|Not sent|Error/i.test(t) ? t.slice(-500) : null
            })
            .catch(() => null)
          if (r) return r
          await wait(1500)
        }
        return null
      })()
      const bodyTail = await slides.evaluate(() => (document.body.textContent || '').slice(-1500)).catch(() => '')
      await log('ppt: round done — ' + (done ? 'signal' : 'timeout') + '; body tail: ' + bodyTail.replace(/\s+/g, ' ').slice(-1100))
      await slides.screenshot({ path: join(SHOTS, '03-after-send.png') })
    } else {
      await log('ppt: no AI composer textarea found')
    }
    await log('PPT SMOKE DONE. shots in', SHOTS)
  } finally {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false }))
    }).catch(() => {})
    await Promise.race([app.close(), new Promise((r) => setTimeout(() => r(), 15000))]).catch(() => {})
  }
})().catch(async (e) => {
  await log('PPT SMOKE ERROR:', e.stack || e.message || e)
  process.exit(1)
})
