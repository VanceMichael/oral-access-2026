// 纯领域核对逻辑：不启动浏览器、不发网络请求，便于后续岗位/轮次复用与测试。

export const STATUSES = Object.freeze({
  READY: 'ready',
  HELD: 'held',
  NOTIFIED: 'notified',
  MANUAL: 'manual_reschedule'
})

export const STATUS_LABELS = Object.freeze({
  ready: '可办理',
  held: '暂留',
  notified: '已通知',
  manual_reschedule: '需人工改约'
})

export const REASON_LABELS = Object.freeze({
  unknown_registration: '报名号不在当前名册',
  unknown_slot: '回执或安排引用了当前资料版中不存在的场次',
  no_schedulable_slot: '当前没有可用于该岗位的场次',
  job_mismatch: '岗位与报名记录不一致',
  round_permission_mismatch: '许可轮次不一致',
  service_not_authorized: '没有对应轮次和服务内容的许可',
  slot_not_open: '场次当前不开放',
  interviewer_closed: '面谈官已封闭窗口',
  does_not_fit: '完整准备和面谈超出允许结束时刻',
  service_offline: '设备/服务时段不可用',
  room_occupied: '设备房已被其他申请占用',
  person_overlap: '正式合并后的同一人员时间重叠',
  missing_prep_minutes: '缺少准备分钟数',
  delivery_not_confirmed: '尚未查到实际送达回执',
  amendment_pending: '改期申请已受理，但新通知尚未实际送达',
  delivery_failed: '通知送达失败',
  stale_edition: '资料版已更换，需要重新采录'
})

const COLUMN_SPECS = {
  entries: [
    ['registrationId', 'string'], ['job', 'string'], ['round', 'string'], ['personCode', 'string']
  ],
  merge: [
    ['registrationA', 'string'], ['registrationB', 'string']
  ],
  access: [
    ['registrationId', 'string'], ['round', 'string'], ['service', 'string'], ['prepMinutes', 'number']
  ],
  slots: [
    ['slotId', 'string'], ['job', 'string'], ['interviewerId', 'string'], ['room', 'string'],
    ['service', 'string'], ['start', 'number'], ['end', 'number'], ['interviewMinutes', 'number'],
    ['status', 'string']
  ],
  notices: [
    ['registrationId', 'string'], ['slotId', 'string'], ['receipt', 'string'], ['status', 'string']
  ]
}

const ACTIVE_HOLD_STATES = new Set(['held', 'confirmed', 'booked', 'reserved', 'available'])
const INACTIVE_HOLD_STATES = new Set(['released', 'cancelled', 'canceled', 'closed'])

export function reason(code, extra = {}) {
  return { code, message: REASON_LABELS[code] || code, ...extra }
}

export function intervalOverlap(a, b) {
  return Number(a[0]) < Number(b[1]) && Number(b[0]) < Number(a[1])
}

export function overlapRange(a, b) {
  if (!intervalOverlap(a, b)) return null
  return [Math.max(a[0], b[0]), Math.min(a[1], b[1])]
}

export function sameInterval(a, b) {
  return Number(a?.[0]) === Number(b?.[0]) && Number(a?.[1]) === Number(b?.[1])
}

function dashToNull(value) {
  return value === '-' || value === '' || value === undefined ? null : value
}

function convertValue(value, type) {
  const v = dashToNull(value)
  if (v === null) return null
  if (type === 'number') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return String(v)
}

export function normalizeRows(name, rows = []) {
  const spec = COLUMN_SPECS[name]
  if (!spec) return rows.map(row => Array.isArray(row) ? { values: row } : { ...row })
  return rows.map((row, index) => {
    if (!Array.isArray(row)) return { ...row }
    const out = { _row: index }
    spec.forEach(([key, type], i) => {
      out[key] = convertValue(row[i], type)
    })
    return out
  })
}

export function selectEdition(sourceData, editionId) {
  const editions = sourceData?.editions || []
  if (!editions.length) return null
  return editions.find(e => e.edition === editionId)
    || editions.find(e => e.edition === sourceData.edition)
    || editions[editions.length - 1]
}

// 接受 records/source.json 的完整结构、单个 edition，或浏览器采录出的 streams。
export function normalizeSource(input = {}) {
  let editionName = input.edition
  let rawStreams = input.streams || input
  if (input.editions) {
    const edition = selectEdition(input, input.requestedEdition)
    editionName = edition.edition
    rawStreams = edition.streams
  } else if (input.streams && typeof input.edition === 'object') {
    editionName = input.edition.edition
    rawStreams = input.edition.streams
  } else if (typeof input.edition === 'string') {
    editionName = input.edition
  }

  const streams = {}
  for (const [name, rows] of Object.entries(rawStreams || {})) {
    streams[name] = normalizeRows(name, rows)
  }
  return {
    edition: editionName || null,
    entries: streams.entries || [],
    merges: streams.merge || streams.merges || [],
    access: streams.access || [],
    slots: streams.slots || [],
    notices: streams.notices || [],
    portalChanges: normalizePortalChanges(input.portalChanges || streams.portalChanges || []),
    streams
  }
}

export function normalizePortalChanges(rows = []) {
  return rows.map((row, i) => {
    if (!Array.isArray(row)) {
      return {
        scope: row.scope ?? row[0] ?? null,
        registrationId: row.ref ?? row.registrationId ?? row[1] ?? null,
        slotId: row.value ?? row.slotId ?? row[2] ?? null,
        state: row.state ?? row[3] ?? null,
        receipt: dashToNull(row.receipt ?? row[4] ?? null),
        _row: i
      }
    }
    return {
      scope: dashToNull(row[0]),
      registrationId: dashToNull(row[1]),
      slotId: dashToNull(row[2]),
      state: dashToNull(row[3]),
      receipt: dashToNull(row[4]),
      _row: i
    }
  }).filter(r => r.registrationId)
}

class UnionFind {
  constructor() { this.parent = new Map() }
  add(x) {
    if (x === null || x === undefined) return
    const key = String(x)
    if (!this.parent.has(key)) this.parent.set(key, key)
  }
  find(x) {
    const key = String(x)
    this.add(key)
    let root = key
    while (this.parent.get(root) !== root) root = this.parent.get(root)
    let cur = key
    while (this.parent.get(cur) !== cur) {
      const next = this.parent.get(cur)
      this.parent.set(cur, root)
      cur = next
    }
    return root
  }
  union(a, b) {
    this.add(a); this.add(b)
    const ra = this.find(a); const rb = this.find(b)
    if (ra !== rb) this.parent.set(rb, ra)
  }
}

// 只有 merge 视图/正式合并回执能建立同组；personCode 相同也不自动合并。
export function buildIdentityGroups(entries = [], merges = [], mergeEvidence = []) {
  const uf = new UnionFind()
  for (const e of entries) uf.add(e.registrationId)
  for (const m of merges) {
    if (m.registrationA && m.registrationB) uf.union(m.registrationA, m.registrationB)
  }
  const map = new Map()
  for (const id of uf.parent.keys()) {
    const root = uf.find(id)
    if (!map.has(root)) map.set(root, [])
    map.get(root).push(id)
  }
  const entryById = new Map(entries.map(e => [e.registrationId, e]))
  const groups = [...map.values()].map(ids => {
    ids.sort()
    const official = merges.some(m =>
      (m.registrationA === ids[0] && m.registrationB === ids[1]) ||
      (m.registrationB === ids[0] && m.registrationA === ids[1])) || ids.length > 1
    return {
      id: ids.slice().sort().join('+'),
      registrationIds: ids,
      personCodes: ids.map(id => entryById.get(id)?.personCode).filter(Boolean),
      officiallyMerged: official && ids.length > 1,
      evidence: ids.length > 1 ? mergeEvidence : []
    }
  })
  const byRegistration = new Map()
  for (const group of groups) {
    for (const id of group.registrationIds) byRegistration.set(id, group)
  }
  return {
    groups,
    byRegistration,
    groupOf(id) {
      return byRegistration.get(String(id)) || {
        id: String(id), registrationIds: [String(id)], personCodes: [], officiallyMerged: false, evidence: []
      }
    },
    samePerson(a, b) {
      if (!a || !b) return false
      return this.groupOf(a).id === this.groupOf(b).id
    }
  }
}

export function accessFor(model, registrationId, service, round = null) {
  const entry = model.entries.find(e => e.registrationId === registrationId)
  const effectiveRound = round || entry?.round || null
  return model.access.find(a =>
    a.registrationId === registrationId &&
    a.round === effectiveRound &&
    (!service || a.service === service)) || null
}

export function occupancyFor(slot, access) {
  const prep = Number(access?.prepMinutes)
  const start = Number(slot?.start)
  const duration = Number(slot?.interviewMinutes)
  if (!Number.isFinite(prep) || prep < 0 || !Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0) {
    return { prepMinutes: Number.isFinite(prep) ? prep : null, prepWindow: null, interviewWindow: null, occupiedWindow: null, fits: false }
  }
  const prepStart = start
  const prepEnd = prepStart + prep
  const interviewStart = prepEnd
  const interviewEnd = interviewStart + duration
  const prepWindow = [prepStart, prepEnd]
  const interviewWindow = [interviewStart, interviewEnd]
  const occupiedWindow = [prepStart, interviewEnd]
  return {
    prepMinutes: prep,
    prepWindow,
    interviewWindow,
    occupiedWindow,
    fits: interviewEnd <= Number(slot.end) && prepStart >= 0
  }
}

export function checkEligibility(registrationId, slot, model, options = {}) {
  const reasons = []
  const entry = model.entries.find(e => e.registrationId === registrationId)
  if (!entry) reasons.push(reason('unknown_registration', { registrationId }))
  if (entry && slot.job && entry.job !== slot.job) {
    reasons.push(reason('job_mismatch', { registrationId, registrationJob: entry.job, slotJob: slot.job }))
  }
  if (options.round && entry?.round && entry.round !== options.round) {
    reasons.push(reason('round_permission_mismatch', { registrationId, entryRound: entry.round, requestedRound: options.round }))
  }
  const permissionRound = entry?.round || options.round || null
  const access = accessFor(model, registrationId, slot.service, permissionRound)
  if (!access) {
    reasons.push(reason('service_not_authorized', {
      registrationId, round: permissionRound, service: slot.service
    }))
  }
  const occupancy = occupancyFor(slot, access)
  if (access && !occupancy.fits) reasons.push(reason('does_not_fit', { registrationId, slotId: slot.slotId }))
  if (slot.status !== 'open') {
    reasons.push(reason(slot.status === 'closed' ? 'interviewer_closed' : 'slot_not_open', {
      slotId: slot.slotId, status: slot.status
    }))
  }
  return {
    eligible: reasons.length === 0,
    reasons,
    entry: entry || null,
    access,
    occupancy,
    round: entry?.round || options.round || null
  }
}

function normalizeRoomConfirmation(r) {
  const window = r.window || r.occupiedWindow || [r.start, r.end]
  return {
    room: r.room,
    start: Number(window[0]),
    end: Number(window[1]),
    window: [Number(window[0]), Number(window[1])],
    person: r.person || r.candidate || null,
    state: r.state || 'held',
    service: r.service || null,
    raw: r
  }
}

export function normalizeRooms(rooms = []) {
  return rooms.map(normalizeRoomConfirmation)
}

export function normalizeReceipts(receipts = []) {
  return receipts.map((r, i) => ({
    registrationId: r.candidate || r.registrationId,
    slotId: r.slot || r.slotId,
    receipt: r.receipt || r.notice || r.id,
    state: r.state,
    by: r.by || null,
    at: r.at || r.deliveredAt || null,
    _row: i,
    raw: r
  }))
}

function isActiveRoomHold(room) {
  if (INACTIVE_HOLD_STATES.has(room.state)) return false
  return ACTIVE_HOLD_STATES.has(room.state) || room.state === 'held'
}

// 汇总浏览器 notices/changes、外部设备回执和本地持久化选择为已知占用。
export function buildBookings(model, context = {}) {
  const { store = {}, rooms = [], identity } = context
  const bookings = new Map()
  const returned = new Set((store.decisions || []).filter(d => d.state === 'returned').map(d => d.key))

  const ensure = (registrationId, slotId) => {
    const key = `${registrationId}@@${slotId}`
    if (!bookings.has(key)) {
      bookings.set(key, {
        key, registrationId, slotId, sources: [], evidence: [], protected: false,
        unsent: true, returned: returned.has(key)
      })
    }
    return bookings.get(key)
  }

  for (const n of model.notices) {
    if (!n.registrationId || !n.slotId) continue
    const b = ensure(n.registrationId, n.slotId)
    b.sourceNotice = n
    b.noticeStatus = n.status
    b.receipt = n.receipt
    b.protected = n.status === 'sent'
    b.unsent = n.status !== 'sent'
    b.evidence.push({ kind: 'portal-notice', ...n })
  }

  for (const c of model.portalChanges) {
    if (!c.registrationId || !c.slotId) continue
    const b = ensure(c.registrationId, c.slotId)
    b.portalChange = c
    b.portalState = c.state
    if (c.state === 'confirmed') b.portalReceipt = c.receipt
    b.evidence.push({ kind: 'portal-action', ...c })
  }

  for (const a of store.amendments || []) {
    if (a.newSlot) {
      const b = ensure(a.candidate, a.newSlot)
      b.amendment = a
      b.evidence.push({ kind: 'amendment-request', ...a })
    }
  }

  // 外部送达回执也可能首次给出新场次，例如 N4/S5。
  for (const r of context.receipts || []) {
    if (!r.registrationId || !r.slotId) continue
    const b = ensure(r.registrationId, r.slotId)
    b.externalReceipt = r
    b.evidence.push({ kind: 'notice-receipt', ...r })
    if (r.state === 'delivered') {
      b.protected = true
      b.unsent = false
    }
  }

  for (const b of bookings.values()) {
    const slot = model.slots.find(s => s.slotId === b.slotId)
    const entry = model.entries.find(e => e.registrationId === b.registrationId)
    const access = slot ? accessFor(model, b.registrationId, slot.service, entry?.round) : null
    b.slot = slot || null
    b.access = access || null
    b.occupancy = slot && access ? occupancyFor(slot, access) : null
    b.identityGroup = identity.groupOf(b.registrationId).id

    const receiptMatches = (context.receipts || []).filter(r =>
      (r.registrationId === b.registrationId && r.slotId === b.slotId) ||
      (b.receipt && r.receipt === b.receipt))
    const oldReceipt = receiptMatches.find(r => r.state === 'superseded')
    const replacementDelivered = oldReceipt?.by
      ? (context.receipts || []).some(r => r.receipt === oldReceipt.by && r.state === 'delivered')
      : false
    const amendmentDelivered = (store.amendments || []).some(a =>
      a.state === 'delivered' && (a.oldReceipt === b.receipt || a.oldReceipt === b.sourceNotice?.receipt))
    if ((oldReceipt && replacementDelivered) || amendmentDelivered) {
      b.lifecycle = 'superseded'
      b.active = false
    } else {
      b.lifecycle = 'active'
      b.active = true
    }
  }

  // 设备回执本身是权威物理占用；即使业务页缺场次也保留为冲突来源。
  const external = rooms.filter(isActiveRoomHold).map(room => ({
    key: `room:${room.room}:${room.window[0]}-${room.window[1]}:${room.person}`,
    registrationId: room.person,
    slotId: null,
    room: room.room,
    externalRoom: room,
    occupancy: { occupiedWindow: room.window },
    protected: true,
    external: true,
    sources: ['room-confirmation']
  }))

  return { bookings: [...bookings.values()], external }
}

export function assessOption(registrationId, slot, context = {}) {
  const { model, identity, rooms = [], bookings = [], ignoreKeys = [], options = {} } = context
  const eligibility = checkEligibility(registrationId, slot, model, options)
  const conflicts = []
  const resourceEvidence = []
  const occ = eligibility.occupancy?.occupiedWindow ? eligibility.occupancy : occupancyFor(slot, eligibility.access)
  const window = occ?.occupiedWindow

  if (window) {
    for (const room of normalizeRooms(rooms)) {
      if (!isActiveRoomHold(room)) continue
      if (!intervalOverlap(window, room.window)) continue
      const samePerson = identity.samePerson(room.person, registrationId)
      const overlap = overlapRange(window, room.window)
      resourceEvidence.push({ kind: 'room-confirmation', ...room.raw, overlap })
      if (room.room === slot.room) {
        if (room.service && room.service !== 'available') {
          conflicts.push(reason('service_offline', { room: room.room, window: room.window, overlap, confirmation: room.raw }))
        }
        const exactOwnHold = samePerson && sameInterval(window, room.window)
        if (exactOwnHold) continue
        if (samePerson) {
          conflicts.push(reason('person_overlap', {
            source: 'room-confirmation', registrationIds: identity.groupOf(registrationId).registrationIds,
            room: room.room, window: room.window, overlap
          }))
        } else {
          conflicts.push(reason('room_occupied', {
            room: slot.room, heldBy: room.person, window: room.window, overlap
          }))
        }
      } else if (samePerson) {
        conflicts.push(reason('person_overlap', {
          source: 'room-confirmation', registrationIds: identity.groupOf(registrationId).registrationIds,
          otherRoom: room.room, window: room.window, overlap
        }))
      }
    }

    for (const b of bookings) {
      if (ignoreKeys.includes(b.key)) continue
      const otherWindow = b.occupancy?.occupiedWindow
      if (!otherWindow || !intervalOverlap(window, otherWindow)) continue
      if (b.active === false || b.lifecycle === 'superseded') continue
      const samePerson = identity.samePerson(b.registrationId, registrationId)
      const sameRoom = b.slot?.room === slot.room
      const overlap = overlapRange(window, otherWindow)
      if (b.returned && !b.protected) continue
      if (samePerson && b.key !== `${registrationId}@@${slot.slotId}`) {
        conflicts.push(reason('person_overlap', {
          source: 'schedule',
          registrationIds: identity.groupOf(registrationId).registrationIds,
          otherRegistrationId: b.registrationId,
          otherSlotId: b.slotId,
          otherRoom: b.slot?.room,
          window: otherWindow,
          overlap,
          protected: b.protected
        }))
      } else if (sameRoom && b.registrationId !== registrationId) {
        conflicts.push(reason('room_occupied', {
          room: slot.room,
          heldBy: b.registrationId,
          otherSlotId: b.slotId,
          window: otherWindow,
          overlap,
          protected: b.protected
        }))
      }
    }
  }

  const blockers = [...eligibility.reasons, ...conflicts]
  return {
    registrationId,
    slotId: slot.slotId,
    available: blockers.length === 0,
    blockers,
    eligibility,
    occupancy: occ,
    resourceEvidence,
    assessedAt: context.at || new Date().toISOString()
  }
}

export function alternativeSlots(registrationIds, model, context = {}) {
  const ids = Array.isArray(registrationIds) ? registrationIds : [registrationIds]
  const out = []
  for (const regId of ids) {
    const entry = model.entries.find(e => e.registrationId === regId)
    for (const slot of model.slots) {
      if (entry?.job && slot.job !== entry.job) continue
      const assessment = assessOption(regId, slot, context)
      out.push({
        registrationId: regId,
        slotId: slot.slotId,
        job: slot.job,
        interviewerId: slot.interviewerId,
        room: slot.room,
        service: slot.service,
        start: slot.start,
        end: slot.end,
        ...assessment.occupancy,
        available: assessment.available,
        blockers: assessment.blockers,
        evidence: assessment.resourceEvidence
      })
    }
  }
  return out
}

function receiptStateFor(itemKey, reg, slotId, sourceReceipt, receipts) {
  const matches = receipts.filter(r =>
    (r.registrationId === reg && r.slotId === slotId) ||
    (sourceReceipt && r.receipt === sourceReceipt))
  const delivered = matches.find(r => r.state === 'delivered')
  const superseded = matches.find(r => r.state === 'superseded')
  const queued = matches.find(r => ['queued', 'pending', 'accepted'].includes(r.state))
  const failed = matches.find(r => ['failed', 'bounced', 'rejected', 'dropped'].includes(r.state))
  const latest = delivered || superseded || matches.at(-1) || null
  return { matches, delivered, superseded, queued, failed, latest }
}

function amendmentFor(reg, sourceReceipt, store) {
  const list = (store.amendments || []).filter(a =>
    a.candidate === reg || a.oldReceipt === sourceReceipt)
  return list.at(-1) || null
}

function inferFocusRound(model, receipts) {
  const counts = new Map()
  const countRound = round => {
    if (!round) return
    counts.set(round, (counts.get(round) || 0) + 1)
  }
  for (const r of receipts || []) {
    countRound(model.entries.find(e => e.registrationId === r.registrationId)?.round)
  }
  if (counts.size) return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
  for (const m of model.merges || []) {
    countRound(model.entries.find(e => e.registrationId === m.registrationA)?.round)
    countRound(model.entries.find(e => e.registrationId === m.registrationB)?.round)
  }
  if (counts.size) return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
  const rounds = new Set(model.entries.map(e => e.round).filter(Boolean))
  return rounds.size === 1 ? [...rounds][0] : null
}

export function reconcile(snapshot = {}, persisted = {}, options = {}) {
  const at = options.at || snapshot.capturedAt || new Date().toISOString()
  const model = normalizeSource(snapshot)
  const rooms = normalizeRooms(snapshot.rooms || [])
  const receipts = normalizeReceipts(snapshot.receipts || [])
  const explicitRound = options.round || null
  const focusRound = explicitRound || inferFocusRound(model, receipts)
  const viewOptions = { ...options, round: focusRound, focusRound, explicitRound }
  const mergeEvidence = (snapshot.evidence?.merge || []).concat(
    model.merges.map(m => ({ kind: 'official-merge', edition: model.edition, ...m }))
  )
  const identity = buildIdentityGroups(model.entries, model.merges, mergeEvidence)
  const built = buildBookings(model, { store: persisted, rooms, receipts, identity })
  const context = { model, identity, rooms, receipts, bookings: built.bookings, options: viewOptions, at }

  const keys = new Set(built.bookings.map(b => b.key))
  // 没有任何业务记录但有名册/许可时，也给出可办理候选；优先锚定第一个完整可用场次。
  for (const e of model.entries) {
    if (focusRound && e.round !== focusRound) continue
    if (model.notices.some(n => n.registrationId === e.registrationId)) continue
    const jobSlots = model.slots.filter(s => !e.job || s.job === e.job)
    if (!jobSlots.length) {
      keys.add(`${e.registrationId}@@UNASSIGNED`)
      continue
    }
    const readySlot = jobSlots.find(s => assessOption(e.registrationId, s, context).available)
    keys.add(`${e.registrationId}@@${(readySlot || jobSlots[0]).slotId}`)
  }

  const items = []
  for (const key of keys) {
    const [registrationId, slotId] = key.split('@@')
    const slot = model.slots.find(s => s.slotId === slotId)
    if (!slot) {
      // 外部回执可能引用当前资料版没有的场次；保留原编号证据，不能静默丢弃。
      const receipt = receipts.find(r => r.registrationId === registrationId && r.slotId === slotId)
      const unknownReason = reason(slotId === 'UNASSIGNED' ? 'no_schedulable_slot' : 'unknown_slot', { slotId })
      items.push({
        id: key, key, registrationId, originalNumber: registrationId,
        slotId: slotId === 'UNASSIGNED' ? null : slotId,
        status: STATUSES.MANUAL,
        statusLabel: STATUS_LABELS.manual_reschedule,
        lifecycle: 'active',
        historyOnly: false,
        reasons: [unknownReason],
        blockers: [unknownReason],
        schedulingBlockers: [unknownReason],
        alternatives: [],
        evidence: [{ kind: 'notice-receipt', ...receipt }].filter(Boolean)
      })
      continue
    }
    const booking = built.bookings.find(b => b.key === key) || { key, registrationId, slotId, evidence: [], protected: false }
    const entry = model.entries.find(e => e.registrationId === registrationId)
    if (explicitRound && entry?.round && entry.round !== explicitRound) continue
    const otherRoundHistory = !explicitRound && Boolean(focusRound && entry?.round && entry.round !== focusRound &&
      (booking.protected || booking.sourceNotice?.status === 'sent' || booking.externalReceipt))

    const assessment = assessOption(registrationId, slot, {
      ...context,
      ignoreKeys: [key]
    })
    const delivery = receiptStateFor(key, registrationId, slotId, booking.receipt || booking.sourceNotice?.receipt, receipts)
    const amendment = amendmentFor(registrationId, booking.receipt || booking.sourceNotice?.receipt, persisted)
    const group = identity.groupOf(registrationId)
    const alternatives = alternativeSlots(group.registrationIds, model, context)
    const currentBlockers = assessment.blockers
    const hasStaging = Boolean(
      booking.sourceNotice || booking.portalChange || booking.externalReceipt ||
      amendment || assessment.resourceEvidence.length || persisted.decisions?.some(d => d.key === key)
    )

    let status
    let lifecycle = 'active'
    const statusReasons = []
    if (delivery.delivered) {
      if (currentBlockers.some(b => ['person_overlap', 'room_occupied', 'service_offline', 'interviewer_closed', 'slot_not_open'].includes(b.code))) {
        status = STATUSES.MANUAL
        statusReasons.push(...currentBlockers)
      } else {
        status = STATUSES.NOTIFIED
      }
    } else if (delivery.superseded) {
      const replacementDelivered = delivery.superseded.by && receipts.some(r =>
        r.receipt === delivery.superseded.by && r.state === 'delivered')
      if (replacementDelivered) {
        status = STATUSES.NOTIFIED
        lifecycle = 'superseded'
      } else {
        status = STATUSES.MANUAL
        statusReasons.push(reason('amendment_pending', { oldReceipt: delivery.superseded.receipt, by: delivery.superseded.by }))
      }
    } else if (amendment?.state === 'accepted_pending_delivery') {
      status = STATUSES.MANUAL
      statusReasons.push(reason('amendment_pending', { oldReceipt: amendment.oldReceipt, httpStatus: amendment.httpStatus }))
    } else if (delivery.failed) {
      status = STATUSES.MANUAL
      statusReasons.push(reason('delivery_failed', { receipt: delivery.failed.receipt }))
    } else if (currentBlockers.some(b => b.code === 'person_overlap' && b.protected !== false)) {
      status = STATUSES.MANUAL
      statusReasons.push(...currentBlockers)
    } else if (currentBlockers.some(b => ['room_occupied', 'service_offline', 'interviewer_closed', 'slot_not_open'].includes(b.code))) {
      // 未发但存在硬冲突：进入人工改约/重排记录。
      status = STATUSES.MANUAL
      statusReasons.push(...currentBlockers)
    } else if (persisted.decisions?.some(d => d.key === key && d.state === 'returned')) {
      status = assessment.available ? (hasStaging ? STATUSES.HELD : STATUSES.READY) : STATUSES.MANUAL
      if (status === STATUSES.MANUAL) statusReasons.push(...currentBlockers)
    } else if (hasStaging) {
      status = STATUSES.HELD
      if (delivery.queued) {
        statusReasons.push(reason('delivery_not_confirmed', { receipt: delivery.queued.receipt, state: delivery.queued.state }))
      } else if (!delivery.delivered && !delivery.superseded) {
        statusReasons.push(reason('delivery_not_confirmed', {
          receipt: booking.receipt || booking.sourceNotice?.receipt || null,
          state: delivery.latest?.state || 'receipt_missing'
        }))
      }
    } else if (assessment.available && assessment.eligibility.eligible) {
      status = STATUSES.READY
    } else {
      status = STATUSES.MANUAL
      statusReasons.push(...assessment.blockers)
    }

    // 合并后与另一报名号的已发安排冲突，即使当前 blocker 的 protected 字段来自 schedule，也强制人工案。
    const mergeConflict = currentBlockers.find(b => b.code === 'person_overlap' &&
      group.officiallyMerged && b.registrationIds?.length > 1)
    if (mergeConflict && status !== STATUSES.NOTIFIED) {
      status = STATUSES.MANUAL
      if (!statusReasons.includes(mergeConflict)) statusReasons.unshift(mergeConflict)
    }
    if (status === STATUSES.HELD && !statusReasons.some(r => r.code === 'delivery_not_confirmed')) {
      statusReasons.push(reason('delivery_not_confirmed', {
        receipt: delivery.latest?.receipt || booking.receipt || booking.sourceNotice?.receipt || null,
        state: delivery.latest?.state || 'receipt_missing'
      }))
    }

    const evidence = [
      ...(booking.evidence || []),
      ...assessment.resourceEvidence.map(e => ({ kind: 'room-confirmation', ...e })),
      ...(persisted.actions || []).filter(a => a.key === key).map(a => ({ ...a, kind: 'local-action', actionKind: a.kind })),
      ...(persisted.decisions || []).filter(d => d.key === key).map(d => ({ kind: 'local-decision', ...d }))
    ]
    if (delivery.matches.length) evidence.push(...delivery.matches.map(r => ({ kind: 'notice-receipt', ...r })))

    items.push({
      id: key,
      key,
      registrationId,
      originalNumber: registrationId,
      relatedRegistrationIds: group.registrationIds.filter(id => id !== registrationId),
      identityGroup: group.id,
      officiallyMerged: group.officiallyMerged,
      job: entry?.job || slot.job,
      round: entry?.round || focusRound || null,
      otherRoundHistory,
      historyOnly: otherRoundHistory,
      slotId,
      interviewerId: slot.interviewerId,
      room: slot.room,
      service: slot.service,
      status,
      statusLabel: STATUS_LABELS[status],
      lifecycle,
      protected: booking.protected || Boolean(delivery.delivered),
      unsent: !booking.protected && !delivery.delivered,
      returnedToPool: Boolean(persisted.decisions?.some(d => d.key === key && d.state === 'returned')),
      sourceNotice: booking.sourceNotice || null,
      portalChange: booking.portalChange || null,
      delivery: {
        state: delivery.delivered ? 'delivered' : delivery.superseded ? 'superseded' : delivery.queued ? 'queued' : delivery.failed ? 'failed' : 'unconfirmed',
        receipt: delivery.latest?.receipt || booking.receipt || null,
        deliveredReceipt: delivery.delivered?.receipt || null,
        supersededBy: delivery.superseded?.by || null,
        matches: delivery.matches
      },
      amendment: amendment || null,
      eligibility: {
        eligible: assessment.eligibility.eligible,
        reasons: assessment.eligibility.reasons
      },
      occupancy: assessment.occupancy?.occupiedWindow ? {
        prepMinutes: assessment.occupancy.prepMinutes,
        prepWindow: assessment.occupancy.prepWindow,
        interviewWindow: assessment.occupancy.interviewWindow,
        occupiedWindow: assessment.occupancy.occupiedWindow
      } : null,
      blockers: Array.from(new Map([...statusReasons, ...currentBlockers].map(r => [r.code + JSON.stringify(r.extra || {}), r])).values()),
      schedulingBlockers: currentBlockers,
      statusReasons,
      alternatives,
      evidence,
      assessedAt: at
    })
  }

  const manualCases = buildManualCases(items.filter(i => !i.historyOnly), context, at)
  const board = { ready: [], held: [], notified: [], manual_reschedule: [] }
  for (const item of items) {
    if (item.historyOnly) continue
    if (item.lifecycle !== 'active' && options.includeHistory !== true) continue
    board[item.status]?.push(item)
  }

  const history = items.filter(i => i.historyOnly || i.lifecycle !== 'active')
  return {
    schemaVersion: 1,
    capturedAt: at,
    edition: model.edition,
    options: viewOptions,
    identityGroups: identity.groups,
    board,
    statusGroups: board,
    todos: items,
    items,
    manualCases,
    conflicts: manualCases,
    history,
    interviewerView: buildInterviewerView(items, model, options.interviewerId || options.interviewer),
    stats: {
      items: items.length,
      ready: board.ready.length,
      held: board.held.length,
      notified: board.notified.length,
      manual_reschedule: board.manual_reschedule.length,
      manualCases: manualCases.length,
      history: history.length
    }
  }
}

function buildManualCases(items, context, at) {
  const clusters = new Map()
  for (const item of items) {
    const hard = item.blockers.filter(b => ['person_overlap', 'room_occupied', 'service_offline', 'interviewer_closed', 'slot_not_open', 'amendment_pending', 'delivery_failed'].includes(b.code))
    if (item.status !== STATUSES.MANUAL || !hard.length) continue

    const partnerIds = new Set([item.registrationId])
    for (const b of hard) {
      for (const id of b.registrationIds || []) partnerIds.add(id)
      if (b.otherRegistrationId) partnerIds.add(b.otherRegistrationId)
      if (b.heldBy && /^[A-Z]\d+$/.test(String(b.heldBy))) partnerIds.add(b.heldBy)
    }
    const originalNumbers = [...partnerIds].sort()
    const round = item.round || context.options?.round || 'all-rounds'
    const key = originalNumbers.join('+') + '@@' + round
    if (!clusters.has(key)) {
      clusters.set(key, {
        id: 'CASE-' + key,
        key,
        originalNumbers,
        registrationIds: originalNumbers,
        round,
        status: 'open',
        reasonCodes: new Set(),
        reasons: new Set(),
        details: [],
        assignments: [],
        rebookableSlots: [],
        protectedNotices: [],
        evidence: [],
        createdAt: at
      })
    }
    const c = clusters.get(key)
    for (const b of hard) {
      c.reasonCodes.add(b.code)
      c.reasons.add(b.message)
      c.details.push(b)
    }
    c.assignments.push({
      registrationId: item.registrationId,
      originalNumber: item.registrationId,
      slotId: item.slotId,
      room: item.room,
      occupancy: item.occupancy,
      status: item.status,
      deliveryState: item.delivery?.state || null,
      protected: item.protected
    })
    for (const alt of item.alternatives?.filter(a => a.available) || []) {
      if (!c.rebookableSlots.some(a => a.registrationId === alt.registrationId && a.slotId === alt.slotId)) {
        c.rebookableSlots.push(alt)
      }
    }
    if (item.protected) {
      c.protectedNotices.push({
        registrationId: item.registrationId,
        receipt: item.delivery?.receipt || item.sourceNotice?.receipt,
        deliveryState: item.delivery?.state,
        doNotWithdraw: true
      })
    }
    c.evidence.push(...item.evidence)
  }

  return [...clusters.values()].map(c => {
    const reasonCodes = [...c.reasonCodes]
    const reasons = [...c.reasons]
    const protectedNotice = c.protectedNotices[0] || null
    return {
      ...c,
      reasonCodes,
      reasons,
      primaryRegistrationId: c.assignments[0]?.registrationId || c.originalNumbers[0],
      slotId: c.assignments[0]?.slotId || null,
      currentWindows: c.assignments[0]?.occupancy || null,
      protectedNotice,
      doNotWithdraw: c.protectedNotices.length > 0,
      // 去重证据，避免同一回执在多个 item 中重复展示。
      evidence: dedupeEvidence(c.evidence)
    }
  })
}

function dedupeEvidence(evidence) {
  const seen = new Set()
  const out = []
  for (const e of evidence) {
    const key = JSON.stringify(e)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(e)
  }
  return out
}

// 面谈官视图采用白名单 DTO：只保留自己场次、时间和准备方式。
export function buildInterviewerView(itemsOrWorld, modelOrInterviewer, maybeInterviewer) {
  let items = itemsOrWorld
  let interviewerId = maybeInterviewer
  if (!Array.isArray(itemsOrWorld) && itemsOrWorld?.items) {
    items = itemsOrWorld.items
    interviewerId = modelOrInterviewer || itemsOrWorld.options?.interviewerId
  } else if (typeof modelOrInterviewer === 'string') {
    interviewerId = modelOrInterviewer
  } else {
    interviewerId = maybeInterviewer
  }
  const rows = items
    .filter(i => !i.historyOnly)
    .filter(i => !interviewerId || i.interviewerId === interviewerId)
    .filter(i => i.lifecycle === 'active')
    // 改期 202 尚未回读送达/资源确认时，新场次不能当成已确定安排展示给面谈官。
    .filter(i => !(i.amendment?.state === 'accepted_pending_delivery' &&
      i.amendment?.newSlot === i.slotId && i.delivery?.state !== 'delivered'))
    .map(i => ({
      slotId: i.slotId,
      start: i.occupancy?.prepWindow?.[0] ?? null,
      preparationStart: i.occupancy?.prepWindow?.[0] ?? null,
      interviewStart: i.occupancy?.interviewWindow?.[0] ?? null,
      interviewEnd: i.occupancy?.interviewWindow?.[1] ?? null,
      end: i.occupancy?.occupiedWindow?.[1] ?? i.end ?? null,
      preparation: {
        service: i.service,
        prepMinutes: i.occupancy?.prepMinutes ?? null
      }
    }))
  return { interviewerId: interviewerId || null, slots: rows }
}

export function planActions(world, options = {}) {
  const actions = []
  for (const item of world.items) {
    if (item.historyOnly) continue
    if (options.round && item.round && item.round !== options.round) continue
    const schedulingClear = Boolean(item.eligibility?.eligible) && (item.schedulingBlockers || []).length === 0
    if ((item.status === STATUSES.READY || item.status === STATUSES.HELD) && schedulingClear) {
      actions.push({
        type: 'portal_arrangement',
        mode: 'draft-review-confirm',
        registrationId: item.registrationId,
        scope: item.job,
        ref: item.registrationId,
        value: item.slotId,
        key: item.key,
        autoAllowed: item.portalChange?.state !== 'confirmed',
        reason: '资格、完整准备时段和面谈时段均可用；门户确认后仍需回读实际送达'
      })
    }
    if (item.status === STATUSES.MANUAL && item.protected && item.delivery?.state === 'delivered') {
      const target = item.alternatives?.find(a => a.available && a.registrationId === item.registrationId)
      const ownResourceBlocked = (item.schedulingBlockers || []).some(b =>
        ['service_offline', 'interviewer_closed', 'slot_not_open', 'room_occupied'].includes(b.code))
      const protectedPersonConflict = (item.schedulingBlockers || []).some(b =>
        b.code === 'person_overlap' && b.protected !== false)
      actions.push({
        type: 'amend_notice',
        candidate: item.registrationId,
        oldReceipt: item.delivery.receipt || item.sourceNotice?.receipt,
        newSlot: target?.slotId || null,
        key: item.key,
        autoAllowed: Boolean(target && ownResourceBlocked),
        requiresHuman: !target || !ownResourceBlocked || protectedPersonConflict,
        reason: !ownResourceBlocked
          ? '旧通知本身仍受保护；不能仅因合并撤旧，冲突编号应走人工处理'
          : target
            ? '旧通知已实际送达且原时段不可用；用原回执发起改期，202 不等于新通知送达'
            : '没有完整可用的替代时段，必须人工处理'
      })
    }
  }
  return actions
}
