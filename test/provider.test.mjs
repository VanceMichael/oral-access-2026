import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { provider } from '../source/provider.mjs'

async function listen(t) {
  const source = provider().listen(0, '127.0.0.1')
  t.after(() => new Promise((resolve, reject) => source.close(error => error ? reject(error) : resolve())))
  await once(source, 'listening')
  return 'http://127.0.0.1:' + source.address().port
}

function post(root, endpoint, value) {
  return fetch(root + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: value === undefined ? undefined : JSON.stringify(value) })
}

test('第二房间已有别人占用，排程更正待独立送达确认', async t => {
  const root = await listen(t)
  await post(root, '/lab?stage=merged')
  const rooms = await (await fetch(root + '/rooms/confirmations')).json()
  assert.equal(rooms[1].person, 'B9')
  assert.equal((await post(root, '/notices/amend', { candidate: 'B1', receipt: 'N1' })).status, 202)
  const receipts = async () => (await (await fetch(root + '/notices/receipts')).json())
  assert.equal((await receipts())[1].state, 'queued')
  await post(root, '/lab?stage=informed')
  assert.equal((await receipts())[1].receipt, 'N3')
  assert.equal((await receipts())[1].state, 'delivered')
})
