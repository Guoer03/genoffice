// Claude-code goal verification: create Excel + 20 varied AI rounds + create
// PPT + 1 round, against the dev shell with claude-code pre-seeded. Runs in
// the background (20 rounds × ~40s exceeds the foreground Bash timeout).
// Run: node e2e/claude-code-goal.cjs
const { _electron: electron } = require('@playwright/test')
const { mkdtemp, writeFile, mkdir, appendFile } = require('node:fs/promises')
const { existsSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { createRequire } = require('node:module')

const SHELL_DIR = resolve(__dirname, '../apps/shell')
const SHELL_MAIN = join(SHELL_DIR, 'out/main/index.js')
const SHOTS = resolve(__dirname, 'artifacts/claude-code-goal')
const LOG = join(SHOTS, 'run.log')
const log = async (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
  console.log(line)
  await appendFile(LOG, line + '\n').catch(() => undefined)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const SHEETS_PROMPTS = [
  'Create a table: headers Name, Age, City in row 1; rows Alice 28 NYC, Bob 34 London, Carol 22 Tokyo.',
  'Set E1 to Notes and E2 to hello.',
  'Formula D2 = B2 + 100, then fill D2 down to D4.',
  'Bold row 1 and freeze the top row.',
  'Format column B as currency with 0 decimals.',
  'Add a column F header "Score" with 90,85,95 in F2:F4.',
  'Set A6 to "Total" and B6 = SUM(B2:B4).',
  'Insert a row above row 2 with "Dan,40,Berlin".',
  'Apply a light blue fill to row 1.',
  'Set C1 cell color to red font.',
  'Merge A1:B1.',
  'Set column A width to 20.',
  'Sort A2:F6 by Age ascending.',
  'Set H1 = "Count" and H2 = COUNTA(A2:A6).',
  'Add a formula I2 = B2 * 2 and fill down.',
  'Wrap text on row 1.',
  'Set A8 to a note: "Updated by Claude".',
  'Apply percent format to column I.',
  'Delete row 5 (Carol).',
  'Set A10 = "Done" and bold it.',
]

;(async () => {
  await mkdir(SHOTS, { recursive: true })
  await writeFile(LOG, '')
  if (!existsSync(SHELL_MAIN)) throw new Error('Shell main not built: ' + SHELL_MAIN)
  const userDataDir = await mkdtemp(join(tmpdir(), 'genoffice-goal-'))
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
  await log('goal: launching dev shell…')
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
    if (/claude-agent-acp|session\/|tool-exec|error|ENOENT.*acp|timed out/i.test(s))
      appendFile(LOG, '[main:stderr] ' + s.trim() + '\n').catch(() => undefined)
  })
  let summary = { sheetsRounds: 0, slidesRound: false }
  try {
    const home = await app.firstWindow()
    await home.waitForFunction(
      () => document.readyState !== 'loading' && location.href !== 'about:blank',
      null,
      { timeout: 30000 },
    ).catch(() => {})
    await wait(1500)

    // ── create Excel ──
    await home.locator('.quick-card').nth(1).click()
    const sheets = await waitForUrl(app, ':5174', 30000)
    await sheets.waitForFunction(() => document.body.textContent?.includes('Sheet1'), null, { timeout: 30000 }).catch(() => {})
    await wait(1200)
    await log('goal: sheets created; starting 20 rounds…')
    const ta = () => sheets.locator('textarea[aria-label="AI instruction"]')
    for (let i = 0; i < SHEETS_PROMPTS.length; i++) {
      const prompt = SHEETS_PROMPTS[i]
      try {
        await ta().fill(prompt)
        await wait(200)
        const send = sheets.locator('button[aria-label="Send"]')
        if (await send.count()) await send.first().click()
        else await ta().press('Enter')
        // wait for the run to finish ("AI finished" appears) — poll the chat area
        const done = await pollFor(sheets, () => sheets
          .evaluate(() => {
            const t = document.body.textContent || ''
            return /AI finished|AI stopped|Retry|Not sent/i.test(t) ? t.slice(-400) : null
          }), 100000)
        summary.sheetsRounds++
        await log(`round ${i + 1}/20: done — ${done ? done.slice(0, 120).replace(/\s+/g, ' ') : '??'}`)
      } catch (e) {
        await log(`round ${i + 1}/20: ERROR ${String(e.message || e).slice(0, 160)}`)
      }
      await wait(500)
    }
    await sheets.screenshot({ path: join(SHOTS, 'sheets-after-20.png') }).catch(() => {})
    await log('goal: sheets 20 rounds done. count=' + summary.sheetsRounds)

    // ── create PPT ──
    await home.bringToFront().catch(() => {})
    await wait(500)
    await home.locator('.quick-card').nth(2).click().catch(async () => {
      // the home window may be hidden behind; try via app windows
      for (const w of app.windows()) {
        if (w.url().includes(':5199')) { await w.bringToFront().catch(() => {}); await w.locator('.quick-card').nth(2).click(); break }
      }
    })
    const slides = await waitForUrl(app, ':5175', 30000)
    await wait(1500)
    await log('goal: slides created; sending 1 round…')
    const sta = slides.locator('textarea[aria-label="AI instruction"]')
    if (await sta.count()) {
      await sta.fill('Create a 3-slide presentation: slide 1 title "Q3 Report", slide 2 "Revenue" with bullet points, slide 3 "Next Steps".')
      await wait(200)
      const send = slides.locator('button[aria-label="Send"]')
      if (await send.count()) await send.first().click()
      else await sta.press('Enter')
      const done = await pollFor(slides, () => slides
        .evaluate(() => {
          const t = document.body.textContent || ''
          return /AI finished|AI stopped|Retry|Not sent/i.test(t) ? t.slice(-400) : null
        }), 150000)
      summary.slidesRound = !!done
      await log('goal: slides round done — ' + (done ? done.slice(0, 120).replace(/\s+/g, ' ') : 'timeout'))
    } else {
      await log('goal: slides AI composer not found')
    }
    await slides.screenshot({ path: join(SHOTS, 'slides-after-1.png') }).catch(() => {})
    await log('GOAL SUMMARY:', summary)
  } finally {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false }))
    }).catch(() => {})
    await Promise.race([app.close(), new Promise((r) => setTimeout(() => r(), 15000))]).catch(() => {})
  }
})().catch(async (e) => {
  await log('GOAL ERROR:', e.stack || e.message || e)
  process.exit(1)
})

async function waitForUrl(app, part, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      if (w.url().includes(part)) return w
      const href = await w.evaluate(() => location.href).catch(() => '')
      if (href.includes(part)) return w
    }
    await app.waitForEvent('window', { timeout: 1000 }).catch(() => {})
  }
  throw new Error('no window with ' + part)
}
async function pollFor(page, fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const r = await fn().catch(() => null)
    if (r) return r
    await wait(1500)
  }
  return null
}
