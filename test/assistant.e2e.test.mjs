import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { createSource } from '../source/source.mjs'
import { provider as createProvider } from '../source/provider.mjs'
import { captureDesk, advancePortalArrangement } from '../assistant/browser.mjs'
import { applyAutomaticActions, syncWorkbench } from '../assistant/workflow.mjs'

async function listen(t, factory) {
  const server = factory()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve())))
  return `http://127.0.0.1:${server.address().port}`
}

test('Chromium 能采录全部分页视图并推进暂存-核对-确认', async t => {
  const root = await listen(t, createSource)
  const browser = await chromium.launch({ args: ['--no-sandbox'] })
  t.after(() => browser.close())

  const captured = await captureDesk(root, { browser })
  assert.equal(captured.edition, 'r1')
  assert.equal(captured.streams.entries.flat().length >= 12, true) // 3 行 × 4 列
  assert.ok(captured.streams.slots.flat().includes('S5'))

  const result = await advancePortalArrangement(root, { scope: 'two', ref: 'B2', value: 'S2' }, { browser })
  assert.equal(result.ok, true)
  assert.match(result.receipt || '', /^RC-/)
  assert.ok(result.results.every(r => r.httpStatus === 200))
})

test('合并演练下端到端保护 N1、用原回执申请改期并回读 N4', async t => {
  const sourceUrl = await listen(t, createSource)
  const providerUrl = await listen(t, createProvider)
  await fetch(sourceUrl + '/control?edition=r2', { method: 'POST' })
  await fetch(providerUrl + '/lab?stage=merged', { method: 'POST' })

  const dir = await mkdtemp(join(tmpdir(), 'oral-access-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const statePath = join(dir, 'workbench.json')
  const browser = await chromium.launch({ args: ['--no-sandbox'] })
  t.after(() => browser.close())
  const browserOptions = { browser }

  const run = await applyAutomaticActions({
    sourceUrl, providerUrl, statePath, round: 'r1', browserOptions, refresh: true
  })
  const amendAudit = run.audit.find(a => a.type === 'amend_notice')
  assert.ok(amendAudit, '应发起 N1 改期')
  assert.equal(amendAudit.result.status, 202)
  assert.equal(amendAudit.result.deliveryConfirmed, false)
  assert.equal(run.world.items.find(i => i.key === 'B1@@S1').status, 'manual_reschedule')
  assert.ok(run.store.cases.some(c => c.originalNumbers.join(',') === 'B1,B2'))

  const labState = await (await fetch(providerUrl + '/lab')).json()
  const amendCall = labState.arrivals.find(a => a.method === 'POST' && a.path === '/notices/amend')
  assert.deepEqual(amendCall.payload, { candidate: 'B1', receipt: 'N1' })

  await fetch(providerUrl + '/lab?stage=informed', { method: 'POST' })
  const readback = await syncWorkbench({ sourceUrl, providerUrl, statePath, round: 'r1', browserOptions })
  const next = readback.world.items.find(i => i.key === 'B1@@S5')
  assert.equal(next.status, 'notified')
  assert.equal(next.delivery.deliveredReceipt, 'N4')
  assert.equal(readback.store.amendments.at(-1).state, 'delivered')
  assert.ok(readback.store.cases.some(c => c.originalNumbers.join(',') === 'B1,B2' && c.status === 'resolved'))
}, { timeout: 120000 })
