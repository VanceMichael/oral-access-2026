import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { createSource } from '../source/source.mjs'
import { provider as createProvider } from '../source/provider.mjs'
import { createWorkbenchServer } from '../assistant/server.mjs'

async function listenFactory(t, factory) {
  const server = factory()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve())))
  return `http://127.0.0.1:${server.address().port}`
}

test('面谈官 HTTP 视图只返回白名单字段', async t => {
  const sourceUrl = await listenFactory(t, createSource)
  const providerUrl = await listenFactory(t, createProvider)
  await fetch(sourceUrl + '/control?edition=r2', { method: 'POST' })
  await fetch(providerUrl + '/lab?stage=merged', { method: 'POST' })
  const dir = await mkdtemp(join(tmpdir(), 'oa-server-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const browser = await chromium.launch({ args: ['--no-sandbox'] })
  t.after(() => browser.close())

  const server = createWorkbenchServer({
    sourceUrl, providerUrl, statePath: join(dir, 'state.json'), browserOptions: { browser }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const root = `http://127.0.0.1:${server.address().port}`

  const response = await fetch(root + '/api/interviewer?as=I1&round=r1')
  assert.equal(response.status, 200)
  const view = await response.json()
  assert.deepEqual(view.slots.map(s => s.slotId), ['S1'])
  const text = JSON.stringify(view)
  for (const secret of ['B1', 'B2', 'B9', 'typing', 'access', 'merge']) {
    // typing 是允许展示的准备方式，因此单独排除在身份字段断言外。
    if (secret === 'typing') continue
    assert.equal(text.includes(secret), false)
  }
  assert.equal(view.slots[0].preparation.service, 'typing')

  const html = await (await fetch(root + '/interviewer?as=I2&round=r1')).text()
  assert.ok(html.includes('S2'))
  assert.equal(html.includes('B1'), false)
  assert.equal(html.includes('B2'), false)
}, { timeout: 120000 })
