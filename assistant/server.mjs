import http from 'node:http'
import { pathToFileURL } from 'node:url'
import { syncWorkbench, applyAutomaticActions } from './workflow.mjs'
import { buildInterviewerView } from './core.mjs'
import { DEFAULT_SOURCE_URL, DEFAULT_PROVIDER_URL } from './services.mjs'
import { DEFAULT_STATE_PATH } from './store.mjs'
import { evidenceLine, formatWindow } from './report.mjs'

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ))
}

function sendHtml(res, code, body) {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>面试便利代办工作台</title>
<style>
body{font:14px/1.5 system-ui,"Noto Sans CJK SC",sans-serif;margin:2rem;color:#172033;background:#f7f8fb}
h1,h2{line-height:1.25}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:1rem;align-items:start}
.card{background:#fff;border:1px solid #d9deea;border-radius:12px;padding:1rem;box-shadow:0 1px 2px #0001}
.item{border-top:1px solid #e7eaf2;padding:.75rem 0}.item:first-of-type{border-top:0}
.badge{display:inline-block;border-radius:999px;padding:.1rem .55rem;font-size:12px;font-weight:700}
.ready{background:#e6f7ed;color:#126c3a}.held{background:#fff4d6;color:#8a5a00}.notified{background:#e6f0ff;color:#174ea6}.manual{background:#ffe8e5;color:#a50e0e}
.muted{color:#667085}.evidence{font-size:12px;color:#475467;margin:.2rem 0 0}.case{border-left:4px solid #d92d20;padding:.5rem .75rem;background:#fff5f4;margin:.75rem 0;border-radius:8px}
button{border:0;border-radius:8px;padding:.55rem .9rem;background:#174ea6;color:#fff;font-weight:700;cursor:pointer}
button.secondary{background:#475467}input{padding:.45rem;border:1px solid #cbd2e1;border-radius:8px}
table{border-collapse:collapse;width:100%;background:#fff}th,td{border:1px solid #d9deea;padding:.45rem;text-align:left}
</style><body>` + body)
}

function layout(title, content) {
  return `<h1>${esc(title)}</h1>
<nav><a href="/liaison">联络员工作台</a> · <a href="/interviewer?as=I1">I1 面谈官视图</a> · <a href="/interviewer?as=I2">I2 面谈官视图</a> · <a href="/api/workbench?format=json">JSON</a></nav>
<p class="muted">所有编号均为本地合成数据；系统保留原报名号、原回执和证据，不使用合并显示名替代编号。</p>${content}`
}

function evidenceHtml(item) {
  const lines = [...new Set((item.evidence || []).slice(-10).map(evidenceLine).filter(Boolean))]
  return lines.map(line => `<p class="evidence">证据：${esc(line)}</p>`).join('')
}

function itemHtml(item) {
  const cls = item.status === 'manual_reschedule' ? 'manual' : item.status
  return `<div class="item">
    <div><span class="badge ${esc(cls)}">${esc(item.statusLabel)}</span>
    <strong>${esc(item.registrationId)} → ${esc(item.slotId)}</strong>
    <span class="muted">${esc(item.room || '')} / ${esc(item.service || '')}</span></div>
    ${item.relatedRegistrationIds?.length ? `<p class="muted">正式同组原号：${esc(item.relatedRegistrationIds.join('、'))}；对外操作仍用各原号。</p>` : ''}
    ${item.occupancy ? `<p>准备 ${esc(formatWindow(item.occupancy.prepWindow))}（${esc(item.occupancy.prepMinutes)} 分钟）；面谈 ${esc(formatWindow(item.occupancy.interviewWindow))}；合计占用 <strong>${esc(formatWindow(item.occupancy.occupiedWindow))}</strong></p>` : ''}
    <p>实际送达：${esc(item.delivery?.state || 'unconfirmed')} ${esc(item.delivery?.receipt || '')}${item.delivery?.supersededBy ? '；已由 ' + esc(item.delivery.supersededBy) + ' 替代并回读' : ''}</p>
    ${item.blockers?.length ? `<p style="color:#a50e0e">${esc(item.blockers.map(b => b.message).join('；'))}</p>` : ''}
    ${evidenceHtml(item)}
  </div>`
}

function liaisonHtml(world, query) {
  const columns = [
    ['ready', '可办理'], ['held', '暂留'], ['notified', '已通知'], ['manual_reschedule', '需人工改约']
  ]
  const cases = world.manualCases.map(c => `<div class="case">
    <strong>原编号：${esc(c.originalNumbers.join('、'))}</strong>
    <p>不能同时办理：${esc(c.reasons.join('；'))}</p>
    <p>涉及：${esc(c.assignments.map(a => `${a.registrationId}/${a.slotId}${a.occupancy ? formatWindow(a.occupancy.occupiedWindow) : ''}`).join('；'))}</p>
    <p>当前可重新预约：${c.rebookableSlots.length ? esc(c.rebookableSlots.map(s => `${s.registrationId}→${s.slotId} ${formatWindow(s.occupiedWindow)}`).join('；')) : '暂无完整可用时段'}</p>
    ${c.doNotWithdraw ? '<p><strong>已送达安排受保护：</strong>不得因合并撤旧；改期必须沿用原回执。202 仅为受理。</p>' : ''}
  </div>`).join('')
  const history = (world.history || []).map(item => `<p class="muted">${esc(item.registrationId)} / ${esc(item.slotId)} / ${esc(item.round || '')} / ${esc(item.lifecycle)} / ${esc(item.delivery?.state || '')}${item.delivery?.supersededBy ? ' → ' + esc(item.delivery.supersededBy) : ''}</p>`).join('')
  return layout('联络员采录与代办工作台', `
  <form method="post" action="/sync" style="display:inline"><button type="submit">重新用 Chromium 采录并核对</button></form>
  <form method="post" action="/apply" style="display:inline"><button class="secondary" type="submit">执行符合条件的代办/改期申请</button></form>
  <p class="muted">资料版 ${esc(world.edition)}；采录时间 ${esc(world.capturedAt)}；轮次过滤 ${esc(query.round || world.options?.focusRound || '全部')}</p>
  ${cases ? `<section class="card"><h2>人工处理记录</h2>${cases}</section>` : ''}
  <div class="grid">${columns.map(([key, label]) => `<section class="card"><h2>${label}（${world.board[key].length}）</h2>${world.board[key].map(itemHtml).join('') || '<p class="muted">无</p>'}</section>`).join('')}</div>
  ${history ? `<section class="card" style="margin-top:1rem"><h2>历史/其他轮次/已替代通知</h2>${history}</section>` : ''}`)
}

function interviewerHtml(view) {
  const rows = view.slots.map(s => `<tr><td>${esc(s.slotId)}</td><td>${esc(s.preparationStart)}</td><td>${esc(formatWindow([s.interviewStart, s.interviewEnd]))}</td><td>${esc(s.preparation.service)}</td><td>${esc(s.preparation.prepMinutes)} 分钟</td></tr>`).join('')
  return layout(`面谈官 ${view.interviewerId || ''} 的场次`, `
  <table><thead><tr><th>场次</th><th>准备开始</th><th>面谈区间</th><th>准备方式</th><th>提前时间</th></tr></thead><tbody>${rows || '<tr><td colspan="5">暂无场次</td></tr>'}</tbody></table>
  <p class="muted">此视图经白名单输出：没有报名号、人员代号、其他岗位、许可详情或合并依据。</p>`)
}

export function createWorkbenchServer(serverOptions = {}) {
  const sourceUrl = serverOptions.sourceUrl || process.env.SOURCE_URL || DEFAULT_SOURCE_URL
  const providerUrl = serverOptions.providerUrl || process.env.PROVIDER_URL || DEFAULT_PROVIDER_URL
  const statePath = serverOptions.statePath || process.env.WORKBENCH_STATE || DEFAULT_STATE_PATH

  async function worldFromQuery(query) {
    const round = query.get('round') || serverOptions.round
    const result = await syncWorkbench({
      sourceUrl, providerUrl, statePath, round, persist: true,
      browserOptions: serverOptions.browserOptions
    })
    return result.world
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      if (url.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ ok: true, sourceUrl, providerUrl }))
      }
      if (req.method === 'POST' && url.pathname === '/sync') {
        await syncWorkbench({ sourceUrl, providerUrl, statePath, persist: true })
        res.writeHead(303, { location: '/liaison' }); return res.end()
      }
      if (req.method === 'POST' && url.pathname === '/apply') {
        await applyAutomaticActions({ sourceUrl, providerUrl, statePath, browserOptions: serverOptions.browserOptions })
        res.writeHead(303, { location: '/liaison' }); return res.end()
      }
      if (url.pathname === '/api/workbench') {
        const world = await worldFromQuery(url.searchParams)
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        return res.end(JSON.stringify(world, null, 2))
      }
      if (url.pathname === '/api/interviewer') {
        const as = url.searchParams.get('as') || serverOptions.interviewerId
        const sync = await syncWorkbench({ sourceUrl, providerUrl, statePath, round: url.searchParams.get('round') || undefined, interviewerId: as, persist: false, browserOptions: serverOptions.browserOptions })
        const view = buildInterviewerView(sync.world.items, as)
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        return res.end(JSON.stringify(view))
      }
      if (url.pathname === '/interviewer') {
        const as = url.searchParams.get('as') || serverOptions.interviewerId
        const sync = await syncWorkbench({ sourceUrl, providerUrl, statePath, round: url.searchParams.get('round') || undefined, interviewerId: as, persist: false, browserOptions: serverOptions.browserOptions })
        return sendHtml(res, 200, interviewerHtml(buildInterviewerView(sync.world.items, as)))
      }
      if (url.pathname === '/liaison' || url.pathname === '/') {
        const world = await worldFromQuery(url.searchParams)
        return sendHtml(res, 200, liaisonHtml(world, url.searchParams))
      }
      sendHtml(res, 404, layout('未找到', '<p>页面不存在</p>'))
    } catch (error) {
      sendHtml(res, 500, layout('工作台暂时不可用', `<pre>${esc(error.stack || error.message)}</pre>`))
    }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.WORKBENCH_PORT || 8710)
  createWorkbenchServer().listen(port, '127.0.0.1', () => {
    console.log(`代办工作台已启动：http://127.0.0.1:${port}/liaison`)
  })
}
