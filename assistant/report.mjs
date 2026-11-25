import { STATUS_LABELS } from './core.mjs'

export function formatWindow(w) {
  return Array.isArray(w) ? `[${w[0]}, ${w[1]})` : '时间待核'
}

export function evidenceLine(e) {
  if (!e) return ''
  switch (e.kind) {
    case 'portal-notice':
      return `报名/排程页 notices：${e.registrationId} / ${e.slotId} / ${e.receipt || '-'} / ${e.status}`
    case 'portal-action':
      return `浏览器门户操作：${e.state}${e.receipt ? ' / ' + e.receipt : ''}`
    case 'notice-receipt':
      return `实际送达回执：${e.registrationId} / ${e.slotId} / ${e.receipt} / ${e.state}${e.by ? '，由 ' + e.by + ' 替代' : ''}`
    case 'room-confirmation':
      return `设备房确认：${e.room} / ${formatWindow(e.window)} / 申请人 ${e.person} / ${e.state}${e.service ? ' / ' + e.service : ''}`
    case 'amendment-request':
      return `改期申请：${e.candidate} / 旧回执 ${e.oldReceipt} -> ${e.newSlot || '待排'} / HTTP ${e.httpStatus}，受理不等于送达`
    case 'local-decision':
      return `本地代办决定：${e.state} / ${e.reason || ''}`
    case 'local-action':
      return `本地审计：${e.actionKind || e.action?.type || '操作'} ${e.error ? '失败：' + e.error.message : '已记录'}`
    case 'official-merge':
      return `正式合并：${e.registrationA} = ${e.registrationB}（资料版 ${e.edition || '-'}）`
    default:
      return `${e.kind || 'evidence'}: ${JSON.stringify(e)}`
  }
}

function itemLines(item) {
  const lines = []
  const ids = item.relatedRegistrationIds?.length
    ? `${item.registrationId}（正式同组原号：${item.relatedRegistrationIds.join(', ')}；对外仍用原号）`
    : item.registrationId
  lines.push(`- ${ids} / ${item.slotId} / ${item.room || '-'} / ${item.service || '-'}`)
  if (item.occupancy) {
    lines.push(`  准备 ${formatWindow(item.occupancy.prepWindow)}（${item.occupancy.prepMinutes} 分钟）；面谈 ${formatWindow(item.occupancy.interviewWindow)}；合计占用 ${formatWindow(item.occupancy.occupiedWindow)}`)
  }
  lines.push(`  送达状态：${item.delivery?.state || 'unconfirmed'}${item.delivery?.receipt ? ' / ' + item.delivery.receipt : ''}${item.delivery?.supersededBy ? ' / 新回执 ' + item.delivery.supersededBy : ''}`)
  if (item.blockers?.length) {
    lines.push('  阻塞/原因：' + item.blockers.map(b => b.message).join('；'))
  }
  const evidence = (item.evidence || []).slice(-8).map(evidenceLine).filter(Boolean)
  for (const line of [...new Set(evidence)]) lines.push('  证据：' + line)
  return lines
}

export function renderTextReport(world) {
  const out = []
  out.push(`采录时间：${world.capturedAt}`)
  out.push(`资料版：${world.edition || '未知'}；状态计数：可办理 ${world.stats.ready}，暂留 ${world.stats.held}，已通知 ${world.stats.notified}，需人工改约 ${world.stats.manual_reschedule}`)
  out.push('')
  for (const status of ['ready', 'held', 'notified', 'manual_reschedule']) {
    out.push(`## ${STATUS_LABELS[status]} (${world.board[status].length})`)
    if (!world.board[status].length) out.push('- 无')
    for (const item of world.board[status]) out.push(...itemLines(item))
    out.push('')
  }
  out.push(`## 人工冲突/改约案 (${world.manualCases.length})`)
  if (!world.manualCases.length) out.push('- 无')
  for (const c of world.manualCases) {
    out.push(`- 原编号：${c.originalNumbers.join('、')}`)
    out.push(`  不能同时办理：${c.reasons.join('；')}`)
    if (c.assignments?.length) {
      out.push('  涉及安排：' + c.assignments.map(a =>
        `${a.registrationId}/${a.slotId}${a.occupancy ? formatWindow(a.occupancy.occupiedWindow) : ''}`).join('；'))
    }
    if (c.rebookableSlots?.length) {
      out.push('  当前可重新预约：' + c.rebookableSlots.map(s =>
        `${s.registrationId} -> ${s.slotId}（${formatWindow(s.occupiedWindow)}，${s.room}/${s.service}）`).join('；'))
    } else {
      out.push('  当前可重新预约：暂无完整可用时段')
    }
    if (c.doNotWithdraw) out.push('  保护：已有实际送达/业务方已发通知，不得因合并撤销；改期必须沿用原回执。')
  }
  const archived = (world.persistedCases || []).filter(c => c.status && c.status !== 'open')
  if (archived.length) {
    out.push('')
    out.push('## 已留档/解决的人工案')
    for (const c of archived) {
      out.push(`- ${c.status}：${c.originalNumbers.join('、')}；${(c.reasonCodes || []).join(', ')}；${c.resolution || c.closure || ''}`)
    }
  }
  const history = world.history || []
  if (history.length) {
    out.push('')
    out.push(`## 历史/其他轮次（${history.length}，不进入当前待办或面谈官视图）`)
    for (const item of history) {
      out.push(`- ${item.registrationId} / ${item.slotId} / 轮次 ${item.round || '-'} / ${item.lifecycle}${item.historyOnly ? ' / 非当前焦点轮次' : ''}；仅按原号留痕，不自动改期`)
    }
  }
  return out.join('\n')
}

export function renderInterviewerText(view) {
  const out = [`面谈官：${view.interviewerId || '未指定（仅显示全部白名单场次）'}`]
  for (const s of view.slots) {
    out.push(`- ${s.slotId}：准备开始 ${s.preparationStart}，面谈 ${formatWindow([s.interviewStart, s.interviewEnd])}；准备方式 ${s.preparation.service}（提前 ${s.preparation.prepMinutes} 分钟）`)
  }
  out.push('')
  out.push('白名单 DTO 不含报名号、人员代号、其他岗位、许可详情或合并依据。')
  return out.join('\n')
}
