import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

export const DEFAULT_STATE_PATH = resolve('.oral-access/workbench.json')

export function emptyStore() {
  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    snapshots: [],
    decisions: [],
    amendments: [],
    actions: [],
    cases: [],
    receiptTrail: {}
  }
}

export async function loadStore(path = DEFAULT_STATE_PATH) {
  const file = resolve(path)
  try {
    const raw = await readFile(file, 'utf8')
    const parsed = JSON.parse(raw)
    return { ...emptyStore(), ...parsed, path: file }
  } catch (error) {
    if (error.code === 'ENOENT') return { ...emptyStore(), path: file }
    throw error
  }
}

export async function saveStore(store, path = store.path || DEFAULT_STATE_PATH) {
  const file = resolve(path)
  await mkdir(dirname(file), { recursive: true })
  const next = { ...store, path: undefined, updatedAt: new Date().toISOString() }
  const tmp = file + '.tmp'
  await writeFile(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
  await rename(tmp, file)
  store.path = file
  store.updatedAt = next.updatedAt
  return file
}

export function recordSnapshot(store, snapshot, world) {
  store.snapshots.push({
    at: snapshot.capturedAt || new Date().toISOString(),
    sourceUrl: snapshot.sourceUrl,
    providerUrl: snapshot.providerUrl,
    edition: world?.edition || snapshot.edition,
    stats: world?.stats || null
  })
  if (store.snapshots.length > 100) store.snapshots = store.snapshots.slice(-100)
}

export function recordAction(store, action) {
  const row = { id: 'A' + (store.actions.length + 1) + '-' + Date.now(), at: new Date().toISOString(), ...action }
  store.actions.push(row)
  return row
}

export function recordDecision(store, key, decision) {
  const row = { key, at: new Date().toISOString(), ...decision }
  store.decisions = store.decisions.filter(d => !(d.key === key && d.state === decision.state))
  store.decisions.push(row)
  return row
}

// 人工案独立持久化：即使后续回读使当前 board 不再显示冲突，原编号和处理轨迹仍保留。
export function persistManualCases(store, world) {
  store.cases ||= []
  const currentKeys = new Set()
  for (const c of world.manualCases || []) {
    currentKeys.add(c.key || c.id)
    const key = c.key || c.id
    const existing = store.cases.find(x => x.key === key)
    if (existing) {
      Object.assign(existing, c, { key, status: existing.status === 'closed' ? 'closed' : 'open', lastSeenAt: new Date().toISOString() })
    } else {
      store.cases.push({ ...c, key, status: 'open', openedAt: new Date().toISOString() })
    }
  }
  for (const oldCase of store.cases) {
    if (oldCase.status === 'open' && !currentKeys.has(oldCase.key)) {
      oldCase.status = 'resolved'
      oldCase.resolvedAt = new Date().toISOString()
      oldCase.resolution = 'fresh_read_no_longer_shows_hard_conflict'
    }
  }
  world.persistedCases = store.cases
  return store.cases
}

export function closeManualCase(store, key, resolution) {
  const c = store.cases.find(x => x.key === key || x.id === key)
  if (!c) return null
  c.status = 'closed'
  c.closedAt = new Date().toISOString()
  c.closure = resolution || 'manual_closed'
  return c
}

export function recordAmendment(store, amendment) {
  const row = {
    id: 'AM' + (store.amendments.length + 1) + '-' + Date.now(),
    requestedAt: new Date().toISOString(),
    state: 'accepted_pending_delivery',
    ...amendment
  }
  store.amendments.push(row)
  if (row.oldReceipt) {
    store.receiptTrail[row.oldReceipt] = {
      oldReceipt: row.oldReceipt,
      candidate: row.candidate,
      amendments: [...(store.receiptTrail[row.oldReceipt]?.amendments || []), row]
    }
  }
  return row
}

export function findReceiptTrail(store, originalReceipt) {
  const amendments = (store.amendments || []).filter(a => a.oldReceipt === originalReceipt)
  const cached = store.receiptTrail?.[originalReceipt] || null
  return cached ? { ...cached, amendments } : { oldReceipt: originalReceipt, amendments }
}
