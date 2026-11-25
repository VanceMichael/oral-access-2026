import { reconcile, planActions } from './core.mjs'
import { collectSnapshot, amendNotice } from './services.mjs'
import {
  loadStore, saveStore, recordSnapshot, recordAction, recordDecision,
  recordAmendment, persistManualCases, emptyStore, DEFAULT_STATE_PATH
} from './store.mjs'
import { advancePortalArrangement } from './browser.mjs'

export { DEFAULT_STATE_PATH }

export async function syncWorkbench(options = {}) {
  const statePath = options.statePath || DEFAULT_STATE_PATH
  const store = options.store || (options.persist === false ? emptyStore() : await loadStore(statePath))
  const snapshot = options.snapshot || await collectSnapshot(options)
  syncAmendmentReadback(store, snapshot)
  const world = reconcile(snapshot, store, options)
  persistManualCases(store, world)
  recordSnapshot(store, snapshot, world)
  if (options.persist !== false) await saveStore(store, statePath)
  return { snapshot, world, store, statePath }
}

export function syncAmendmentReadback(store, snapshot) {
  const receipts = snapshot.receipts || []
  for (const amendment of store.amendments || []) {
    if (amendment.state === 'delivered') continue
    const oldReceipt = receipts.find(r =>
      (amendment.oldReceipt && (r.receipt === amendment.oldReceipt)) ||
      (amendment.candidate && r.candidate === amendment.candidate && r.slot === amendment.newSlot))
    const byReceipt = oldReceipt?.state === 'superseded' && oldReceipt.by
      ? receipts.find(r => r.receipt === oldReceipt.by && r.state === 'delivered')
      : null
    const newDirect = amendment.newSlot
      ? receipts.find(r => r.candidate === amendment.candidate && r.slot === amendment.newSlot && r.state === 'delivered')
      : null
    const delivered = byReceipt || newDirect
    if (delivered) {
      amendment.state = 'delivered'
      amendment.newReceipt = delivered.receipt
      amendment.deliveredAt = new Date().toISOString()
      amendment.readback = delivered
    }
  }
}

// 合并后，未实际送达且与已发安排冲突的编号只在本地退回候选池；不调用任何撤旧通知接口。
export function returnUnsentConflicts(world, store) {
  const decisions = []
  for (const item of world.items) {
    if (!item.unsent || item.protected) continue
    const conflict = item.schedulingBlockers?.some(b => b.code === 'person_overlap' && b.protected !== false)
      || item.manualCases?.length
    if (item.status === 'manual_reschedule' && conflict) {
      const d = recordDecision(store, item.key, {
        state: 'returned',
        registrationId: item.registrationId,
        slotId: item.slotId,
        reason: 'official_merge_conflict_unsent_returned_to_pool',
        originalNumbers: world.manualCases.find(c => c.primaryRegistrationId === item.registrationId)?.originalNumbers || [item.registrationId]
      })
      decisions.push(d)
    }
  }
  return decisions
}

function freshItem(world, key) {
  return world.items.find(i => i.key === key)
}

export async function applyAutomaticActions(options = {}) {
  const statePath = options.statePath || DEFAULT_STATE_PATH
  let current = options.current || await syncWorkbench({ ...options, statePath, persist: true })
  let { world, store } = current
  const audit = []

  if (options.returnUnsent !== false) {
    const decisions = returnUnsentConflicts(world, store)
    if (decisions.length) {
      audit.push({ type: 'return_unsent', decisions })
      await saveStore(store, statePath)
      current = await syncWorkbench({ ...options, statePath, persist: true })
      world = current.world
      store = current.store
    }
  }

  let actions = planActions(world, options)
  if (options.types) actions = actions.filter(a => options.types.includes(a.type))
  if (options.dryRun) return { dryRun: true, actions, audit, world, store }

  for (const action of actions) {
    // 执行前重新采录，避免设备被另一岗位先取走或窗口刚被封闭。
    if (options.refresh !== false) {
      current = await syncWorkbench({ ...options, statePath, persist: true })
      world = current.world
      store = current.store
      const latest = freshItem(world, action.key)
      if (!latest) continue
      if (action.type === 'portal_arrangement') {
        const clear = latest.eligibility?.eligible && latest.schedulingBlockers?.length === 0
        const alreadyConfirmed = latest.portalChange?.state === 'confirmed'
        if (!clear || alreadyConfirmed) {
          audit.push({ type: 'skip', action, reason: alreadyConfirmed ? 'portal_already_confirmed' : 'no_longer_available', at: new Date().toISOString() })
          continue
        }
      }
      if (action.type === 'amend_notice') {
        const pending = store.amendments.some(a => a.oldReceipt === action.oldReceipt && a.state === 'accepted_pending_delivery')
        if (pending) {
          audit.push({ type: 'skip', action, reason: 'amendment_already_pending_readback', at: new Date().toISOString() })
          continue
        }
        const target = latest.alternatives?.find(a => a.slotId === action.newSlot && a.available && a.registrationId === action.candidate)
        const ownBlocked = latest.schedulingBlockers?.some(b =>
          ['service_offline', 'interviewer_closed', 'slot_not_open', 'room_occupied'].includes(b.code))
        if (!target || !ownBlocked) {
          audit.push({ type: 'skip', action, reason: 'amend_precondition_changed', at: new Date().toISOString() })
          continue
        }
      }
    }

    try {
      if (action.type === 'amend_notice') {
        const pending = store.amendments.some(a => a.oldReceipt === action.oldReceipt && a.state === 'accepted_pending_delivery')
        if (pending) continue
        const result = await amendNotice(options.providerUrl, {
          candidate: action.candidate,
          receipt: action.oldReceipt
        })
        const amendment = recordAmendment(store, {
          candidate: action.candidate,
          oldReceipt: action.oldReceipt,
          newSlot: action.newSlot,
          providerUrl: options.providerUrl,
          httpStatus: result.status,
          accepted: result.accepted,
          responseBody: result.body,
          deliveryConfirmed: false
        })
        const row = recordAction(store, { kind: 'amend_notice', key: action.key, input: action, result, amendmentId: amendment.id })
        audit.push({ type: action.type, action, result, amendment, auditId: row.id })
      } else if (action.type === 'portal_arrangement' && options.portal !== false) {
        const result = await advancePortalArrangement(options.sourceUrl, {
          scope: action.scope,
          ref: action.ref,
          value: action.value
        }, { headless: options.headless ?? true, ...(options.browserOptions || {}) })
        const row = recordAction(store, { kind: 'portal_arrangement', key: action.key, input: action, result })
        audit.push({ type: action.type, action, result, auditId: row.id })
      }
      await saveStore(store, statePath)
    } catch (error) {
      const row = recordAction(store, {
        kind: action.type, key: action.key, input: action, error: { message: error.message, code: error.code, result: error.result }
      })
      audit.push({ type: 'error', action, error: { message: error.message, code: error.code }, auditId: row.id })
      await saveStore(store, statePath)
      if (options.throwOnError) throw error
    }
  }

  const finalState = await syncWorkbench({ ...options, statePath, persist: true })
  return { dryRun: false, actions, audit, world: finalState.world, snapshot: finalState.snapshot, store: finalState.store }
}
