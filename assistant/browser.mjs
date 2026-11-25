import { chromium } from 'playwright'

export const ACTION_LABELS = Object.freeze({
  draft: '暂存安排',
  review: '核对通知',
  confirm: '发确认'
})

async function readTableRows(page, name) {
  const table = page.getByRole('table', { name, exact: true })
  await table.waitFor({ state: 'visible', timeout: 10000 })
  return table.locator('tbody tr').evaluateAll(rows =>
    rows.map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent.trim())))
}

async function readEdition(page) {
  const output = page.locator('output[aria-label="资料版"]')
  if (await output.count()) return (await output.first().textContent()).trim()
  const status = page.getByRole('status', { name: '资料版' })
  if (await status.count()) return (await status.first().textContent()).trim()
  return null
}

async function readMessage(page) {
  const message = page.locator('p[role="status"]')
  if (!await message.count()) return ''
  return (await message.first().textContent() || '').trim()
}

export async function launchBrowser(options = {}) {
  return chromium.launch({
    headless: options.headless ?? true,
    args: options.args || ['--no-sandbox', '--disable-dev-shm-usage']
  })
}

export async function withBrowser(callback, options = {}) {
  let browser = options.browser || null
  let context = options.context || null
  const ownsBrowser = !options.browser && !options.page
  const ownsContext = !options.context && !options.page
  let page = options.page || null
  let createdPage = false

  if (!page) {
    if (!browser) browser = await launchBrowser(options)
    if (!context) context = await browser.newContext({ acceptDownloads: false })
    page = await context.newPage()
    createdPage = true
  }

  try {
    return await callback({ browser, context: page.context(), page })
  } finally {
    if (createdPage && options.context) await page.close().catch(() => {})
    if (ownsContext && context) await context.close().catch(() => {})
    if (ownsBrowser && browser) await browser.close().catch(() => {})
  }
}

// 用真实 Chromium 逐视图、逐分页采录。页面可见列顺序由 core 的 schema 解析。
export async function captureDesk(sourceUrl, options = {}) {
  return withBrowser(async ({ page }) => {
    const base = sourceUrl.replace(/\/$/, '')
    await page.goto(base + '/desk', { waitUntil: 'domcontentloaded', timeout: options.timeout || 20000 })
    const edition = await readEdition(page)
    const viewLinks = await page.locator('nav[aria-label="业务视图"] a').evaluateAll(links =>
      links.map(a => {
        try { return new URL(a.href).searchParams.get('view') } catch { return null }
      }).filter(Boolean))
    const views = [...new Set(viewLinks.length ? viewLinks : ['entries'])]
    const streams = {}

    for (const view of views) {
      await page.goto(`${base}/desk?view=${encodeURIComponent(view)}`, { waitUntil: 'domcontentloaded' })
      const rows = []
      for (;;) {
        rows.push(...await readTableRows(page, view))
        const next = page.getByRole('link', { name: '下一页', exact: true })
        if (!await next.count()) break
        await Promise.all([
          page.waitForLoadState('domcontentloaded'),
          next.first().click()
        ])
      }
      streams[view] = rows
    }

    const portalChanges = await readTableRows(page, '本次门户操作').catch(() => [])
    return {
      sourceUrl: base,
      capturedAt: new Date().toISOString(),
      edition,
      streams,
      portalChanges,
      message: await readMessage(page),
      browser: 'playwright/chromium'
    }
  }, options)
}

export async function performPortalAction(sourceUrl, input, action, options = {}) {
  return withBrowser(async ({ page }) => {
    const base = sourceUrl.replace(/\/$/, '')
    await page.goto(base + '/desk?view=entries', { waitUntil: 'domcontentloaded' })
    await page.getByLabel('岗位', { exact: false }).fill(String(input.scope ?? input.job ?? ''))
    await page.getByLabel('报名号', { exact: false }).fill(String(input.ref ?? input.registrationId ?? ''))
    await page.getByLabel('场次', { exact: false }).fill(String(input.value ?? input.slotId ?? ''))
    const buttonName = ACTION_LABELS[action] || action
    const responsePromise = page.waitForResponse(resp =>
      resp.url().includes('/desk') && resp.request().method() === 'POST', { timeout: 10000 })
    await page.getByRole('button', { name: buttonName, exact: true }).click()
    const response = await responsePromise.catch(() => null)
    await page.waitForLoadState('domcontentloaded').catch(() => {})
    const message = await readMessage(page)
    const bodyText = await page.locator('body').innerText().catch(() => '')
    const changes = await readTableRows(page, '本次门户操作').catch(() => [])
    const stale = /资料版已更换|暂存或校验已失效/.test(bodyText) || response?.status?.() === 409
    return {
      action,
      input: {
        scope: input.scope ?? input.job,
        ref: input.ref ?? input.registrationId,
        value: input.value ?? input.slotId
      },
      httpStatus: response?.status?.() || null,
      ok: Boolean(response?.ok()) && !stale,
      stale,
      message,
      edition: await readEdition(page),
      changes,
      at: new Date().toISOString()
    }
  }, options)
}

// 严格按暂存 -> 核对 -> 发确认推进；每一步都使用同一组岗位/报名号/场次。
export async function advancePortalArrangement(sourceUrl, input, options = {}) {
  const results = []
  for (const action of ['draft', 'review', 'confirm']) {
    const result = await performPortalAction(sourceUrl, input, action, options)
    results.push(result)
    if (!result.ok) {
      const error = new Error(result.message || `门户操作 ${action} 未成功`)
      error.code = result.stale ? 'STALE_EDITION' : 'PORTAL_ACTION_FAILED'
      error.result = result
      error.results = results
      throw error
    }
  }
  const last = results.at(-1)
  const confirmedRow = last.changes
    .map(row => Array.isArray(row) ? ({ scope: row[0], ref: row[1], value: row[2], state: row[3], receipt: row[4] }) : row)
    .find(row => row.ref === input.ref && row.value === input.value && row.state === 'confirmed')
  return { ok: true, results, receipt: confirmedRow?.receipt || null, changes: last.changes }
}
