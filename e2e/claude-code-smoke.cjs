// Claude-code smoke test: launches the DEV shell (dev renderers + dev main +
// rebuilt preloads) against a scratch userData, creates a new Excel, opens
// settings, selects the Claude Code provider, sends one chat message, and
// screenshots/logs — validates the ACP backend end-to-end without touching the
// real install. Run: node e2e/claude-code-smoke.cjs
const { _electron: electron } = require('@playwright/test')
const { mkdtemp, writeFile, mkdir, appendFile } = require('node:fs/promises')
const { existsSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { createRequire } = require('node:module')

const SHELL_DIR = resolve(__dirname, '../apps/shell')
const SHELL_MAIN = join(SHELL_DIR, 'out/main/index.js')
const SHOTS = resolve(__dirname, 'artifacts/claude-code')
const LOG = join(SHOTS, 'run.log')
const log = async (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
  console.log(line)
  await appendFile(LOG, line + '\n').catch(() => undefined)
}

;(async () => {
  await mkdir(SHOTS, { recursive: true })
  await writeFile(LOG, '')
  if (!existsSync(SHELL_MAIN)) throw new Error('Shell main not built: ' + SHELL_MAIN)
  const userDataDir = await mkdtemp(join(tmpdir(), 'genoffice-cc-'))
  await writeFile(join(userDataDir, 'app-settings.json'), JSON.stringify({ onboardingSeen: true }))
  // pre-seed Claude Code as the AI provider so we skip the settings UI drive
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
  await log('launching dev shell…')
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
  // stream main-process console + stderr into the log (adapter spawn/errors)
  app.process().stdout?.on('data', (d) => log('[main:stdout]', d.toString().trim()))
  app.process().stderr?.on('data', (d) => log('[main:stderr]', d.toString().trim()))
  try {
    const page = await app.firstWindow()
    await page
      .waitForFunction(
        () => document.readyState !== 'loading' && location.href !== 'about:blank',
        null,
        { timeout: 30000 },
      )
      .catch(() => {})
    await page.waitForTimeout(1500)
    await page.screenshot({ path: join(SHOTS, '01-home.png') })
    await log('home windows:', app.windows().map((w) => w.url()))

    // create a new Excel via the "AI Sheets" quick-card
    await page.locator('.quick-card').nth(1).click()
    let sheets = null
    const deadline = Date.now() + 30000
    while (Date.now() < deadline && !sheets) {
      for (const w of app.windows()) {
        if (w.url().includes(':5174')) {
          sheets = w
          break
        }
      }
      if (!sheets) await app.waitForEvent('window', { timeout: 1000 }).catch(() => {})
    }
    if (!sheets) throw new Error('sheets window never opened; windows=' + app.windows().map((w) => w.url()))
    await sheets
      .waitForFunction(() => document.body.textContent?.includes('Sheet1'), null, { timeout: 30000 })
      .catch(() => {})
    await sheets.waitForTimeout(1500)
    await sheets.screenshot({ path: join(SHOTS, '02-sheets.png') })
    await log('sheets ready:', sheets.url())

    // dump the sheets DOM text + any [aria-label]/button labels to find
    // settings + chat-input selectors
    const probe = await sheets.evaluate(() => {
      const labels = [...document.querySelectorAll('[aria-label]')].map((e) => ({
        al: e.getAttribute('aria-label'),
        tag: e.tagName,
        cls: e.className,
      }))
      const buttons = [...document.querySelectorAll('button')].map((b) => ({
        t: (b.textContent || '').trim().slice(0, 24),
        al: b.getAttribute('aria-label'),
        cls: b.className,
      }))
      const inputs = [...document.querySelectorAll('textarea,input[type=text],input:not([type])')].map((i) => ({
        tag: i.tagName,
        al: i.getAttribute('aria-label'),
        ph: i.placeholder,
        cls: i.className,
      }))
      return {
        bodyHead: (document.body.textContent || '').slice(0, 400),
        nLabels: labels.length,
        labels: labels.slice(0, 40),
        buttons: buttons.slice(0, 60),
        inputs: inputs.slice(0, 20),
      }
    })
    await log('sheets probe:', probe)
    await sheets.screenshot({ path: join(SHOTS, '03-sheets-probed.png') })

    // send one chat prompt via the AI composer (Enter to send) and wait for the
    // claude-agent-acp adapter to spawn + stream a response
    const ta = sheets.locator('textarea[aria-label="AI instruction"]')
    await ta.fill('Create a small table: 3 rows with headers Name, Age, City and sample data.')
    await sheets.waitForTimeout(300)
    // send: try the Send button (aria-label 'Send'), else Enter
    const sendBtn = sheets.locator('button[aria-label="Send"]')
    if (await sendBtn.count()) {
      await sendBtn.first().click()
      await log('clicked Send button')
    } else {
      await ta.press('Enter')
      await log('pressed Enter (no Send button found)')
    }
    await log('prompt sent; waiting for ACP response…')
    let body0 = ''
    let bodyNow = ''
    const t0 = Date.now()
    let got = false
    while (Date.now() - t0 < 90000) {
      bodyNow = await sheets
        .evaluate(() => (document.body.textContent || '').slice(0, 3000))
        .catch(() => '')
      if (!body0) body0 = bodyNow
      if (bodyNow.length > body0.length + 40) {
        got = true
        break
      }
      await sheets.waitForTimeout(1500)
    }
    await log('chat response got=', got, 'body0 len', body0.length, 'bodyNow len', bodyNow.length)
    await sheets.screenshot({ path: join(SHOTS, '04-after-send.png') })
    await log('chat body tail:', bodyNow.slice(-1500))
    await log('SMOKE DONE. shots in', SHOTS)
  } finally {
    // stub the save dialog so close doesn't hang on a dirty workbook
    await app
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false }))
      })
      .catch(() => {})
    await Promise.race([app.close(), new Promise((r) => setTimeout(() => r(), 15000))]).catch(() => {})
  }
})().catch(async (e) => {
  await log('SMOKE ERROR:', e.stack || e.message || e)
  process.exit(1)
})
