import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  reconcile, normalizeSource, buildIdentityGroups, alternativeSlots,
  normalizeRooms, normalizeReceipts, buildBookings, planActions, buildInterviewerView,
  assessOption, intervalOverlap
} from '../assistant/core.mjs'

const source = JSON.parse(await readFile(new URL('../records/source.json', import.meta.url), 'utf8'))
const provider = JSON.parse(await readFile(new URL('../records/provider.json', import.meta.url), 'utf8'))
const edition = name => source.editions.find(e => e.edition === name)
const external = (stage, path) => provider.stages[stage].find(x => x.path === path).body
const snapshot = (name, stage) => ({
  ...edition(name),
  rooms: external(stage, '/rooms/confirmations'),
  receipts: external(stage, '/notices/receipts')
})

test('准备时段按半开区间计入占用', () => {
  const model = normalizeSource(edition('r2'))
  const identity = buildIdentityGroups(model.entries, model.merges)
  const context = {
    model, identity,
    rooms: normalizeRooms(external('merged', '/rooms/confirmations')),
    receipts: normalizeReceipts(external('merged', '/notices/receipts')),
    bookings: [], options: { round: 'r1' }
  }
  const b1s1 = alternativeSlots(['B1'], model, context).find(s => s.slotId === 'S1')
  const b2s2 = alternativeSlots(['B2'], model, context).find(s => s.slotId === 'S2')
  const b2s3 = alternativeSlots(['B2'], model, context).find(s => s.slotId === 'S3')
  const b1s5 = alternativeSlots(['B1'], model, context).find(s => s.slotId === 'S5')
  assert.deepEqual(b1s1.occupiedWindow, [20, 37])
  assert.deepEqual(b2s2.occupiedWindow, [35, 53])
  assert.deepEqual(b2s3.occupiedWindow, [55, 73])
  assert.deepEqual(b1s5.occupiedWindow, [81, 98])
  assert.equal(b1s1.available, false)
  assert.ok(b1s1.blockers.some(b => b.code === 'service_offline'))
  assert.equal(b2s3.available, false)
  assert.ok(b2s3.blockers.some(b => b.code === 'room_occupied' && b.heldBy === 'B9'))
  assert.equal(b1s5.available, true)
})

test('r1 未读到正式合并时不按 personCode 或猜测合并', () => {
  const model = normalizeSource(edition('r1'))
  const identity = buildIdentityGroups(model.entries, model.merges)
  assert.equal(identity.samePerson('B1', 'B2'), false)
  const world = reconcile(snapshot('r1', 'single'), {}, { round: 'r1' })
  assert.equal(world.board.notified.length, 1)
  assert.equal(world.board.held.length, 1)
  assert.equal(world.board.manual_reschedule.length, 0)
  const b1 = world.items.find(i => i.key === 'B1@@S1')
  const b2 = world.items.find(i => i.key === 'B2@@S2')
  assert.equal(b1.status, 'notified')
  assert.equal(b1.delivery.state, 'delivered')
  assert.equal(b2.status, 'held')
  assert.equal(b2.delivery.state, 'queued')
  assert.ok(b2.evidence.some(e => e.kind === 'notice-receipt' && e.state === 'queued'))
})

test('r2 正式合并后保留原编号并生成人工冲突、原因和可约时段', () => {
  const world = reconcile(snapshot('r2', 'merged'), {}, { round: 'r1' })
  assert.equal(world.identityGroups.find(g => g.registrationIds.includes('B1')).officiallyMerged, true)
  const b1 = world.items.find(i => i.key === 'B1@@S1')
  const b2 = world.items.find(i => i.key === 'B2@@S2')
  assert.equal(b1.originalNumber, 'B1')
  assert.deepEqual(b1.relatedRegistrationIds, ['B2'])
  assert.equal(b1.status, 'manual_reschedule')
  assert.equal(b2.status, 'manual_reschedule')
  const personConflict = b2.blockers.find(b => b.code === 'person_overlap')
  assert.deepEqual(personConflict.overlap, [35, 37])
  const c = world.manualCases.find(c => c.originalNumbers.includes('B1') && c.originalNumbers.includes('B2'))
  assert.ok(c)
  assert.deepEqual(c.originalNumbers, ['B1', 'B2'])
  assert.ok(c.reasonCodes.includes('person_overlap'))
  assert.ok(c.reasonCodes.includes('service_offline'))
  assert.ok(c.doNotWithdraw)
  assert.ok(c.rebookableSlots.some(s => s.registrationId === 'B1' && s.slotId === 'S5' && s.available))
  assert.ok(!c.rebookableSlots.some(s => s.slotId === 'S3'))
  const actions = planActions(world, { round: 'r1' })
  const amend = actions.find(a => a.type === 'amend_notice' && a.oldReceipt === 'N1')
  assert.equal(amend.candidate, 'B1')
  assert.equal(amend.newSlot, 'S5')
  assert.equal(amend.autoAllowed, true)
})

test('只有合并冲突而旧通知仍可用时，不允许仅因合并自动改期', () => {
  const snap = snapshot('r2', 'merged')
  snap.rooms = [] // 去掉 service=offline 与 B9 占用，仅留下 B1/S1 与 B2/S2 的合并人员冲突。
  const world = reconcile(snap, {}, { round: 'r1' })
  const action = planActions(world).find(a => a.type === 'amend_notice' && a.oldReceipt === 'N1')
  assert.ok(action)
  assert.equal(action.autoAllowed, false)
  assert.equal(action.requiresHuman, true)
})

test('202 改期受理不是送达；回读 N4 delivered 和 S5 资源回执后才已通知', () => {
  const pendingStore = {
    amendments: [{ candidate: 'B1', oldReceipt: 'N1', newSlot: 'S5', state: 'accepted_pending_delivery', httpStatus: 202 }]
  }
  const pending = reconcile(snapshot('r2', 'merged'), pendingStore, { round: 'r1' })
  const oldItem = pending.items.find(i => i.key === 'B1@@S1')
  assert.equal(oldItem.status, 'manual_reschedule')
  assert.ok(oldItem.amendment.state === 'accepted_pending_delivery')
  const pendingInterviewer = buildInterviewerView(pending.items, 'I1')
  assert.deepEqual(pendingInterviewer.slots.map(s => s.slotId), ['S1'])

  const informedSnapshot = snapshot('r2', 'informed')
  const informedStore = {
    amendments: [{ candidate: 'B1', oldReceipt: 'N1', newSlot: 'S5', state: 'delivered', newReceipt: 'N4' }]
  }
  const world = reconcile(informedSnapshot, informedStore, { round: 'r1' })
  const next = world.items.find(i => i.key === 'B1@@S5')
  assert.equal(next.status, 'notified')
  assert.equal(next.delivery.deliveredReceipt, 'N4')
  assert.deepEqual(next.occupancy.occupiedWindow, [81, 98])
  const old = world.items.find(i => i.key === 'B1@@S1')
  assert.equal(old.lifecycle, 'superseded')
  assert.equal(old.status, 'notified')
  assert.equal(world.board.held.some(i => i.key === 'B2@@S2'), true)
})

test('许可严格按报名号、轮次和服务内容生效，B3 的 r1 typing 不能用于 r2', () => {
  const all = reconcile(snapshot('r2', 'merged'), {}, {})
  const b3s4 = all.items.find(i => i.key === 'B3@@S4')
  assert.ok(b3s4)
  assert.equal(b3s4.eligibility.eligible, false)
  assert.ok(b3s4.eligibility.reasons.some(r => r.code === 'service_not_authorized'))
  const r1Only = reconcile(snapshot('r2', 'merged'), {}, { round: 'r1' })
  assert.equal(r1Only.items.some(i => i.registrationId === 'B3'), false)
})

test('边界相接不冲突，封闭窗口和资格缺失会阻止自动代办', () => {
  const model = normalizeSource(edition('r1'))
  const identity = buildIdentityGroups(model.entries, [])
  assert.equal(intervalOverlap([20, 37], [37, 53]), false)
  const closedSlot = { ...model.slots[0], slotId: 'SX', status: 'closed' }
  const context = { model, identity, rooms: [], bookings: [], options: { round: 'r1' } }
  const closed = assessOption('B1', closedSlot, context)
  assert.equal(closed.available, false)
  assert.ok(closed.blockers.some(b => b.code === 'interviewer_closed'))
  const wrongService = assessOption('B2', { ...model.slots[1], slotId: 'SY', service: 'basic' }, context)
  assert.equal(wrongService.available, false)
  assert.ok(wrongService.blockers.some(b => b.code === 'service_not_authorized'))
})

test('面谈官 DTO 仅含自己场次的时间和准备方式，不含身份/许可/合并字段', () => {
  const world = reconcile(snapshot('r2', 'merged'), {}, { round: 'r1' })
  const view = buildInterviewerView(world.items, 'I1')
  assert.deepEqual(view.slots.map(s => s.slotId), ['S1'])
  const text = JSON.stringify(view)
  for (const secret of ['B1', 'B2', 'B9', 'P', 'access', 'merge', '许可', 'one', 'two']) {
    assert.equal(text.includes(secret), false, `不应包含 ${secret}`)
  }
  assert.deepEqual(view.slots[0].preparation, { service: 'typing', prepMinutes: 5 })
})
