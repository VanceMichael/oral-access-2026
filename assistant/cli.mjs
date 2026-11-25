#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { readFile, writeFile } from 'node:fs/promises'
import { reconcile } from './core.mjs'
import { captureDesk } from './browser.mjs'
import {
  DEFAULT_SOURCE_URL, DEFAULT_PROVIDER_URL, fetchProviderState,
  amendNotice, setLabStage, fetchReceiptTrail
} from './services.mjs'
import { syncWorkbench, applyAutomaticActions, DEFAULT_STATE_PATH } from './workflow.mjs'
import { loadStore, findReceiptTrail } from './store.mjs'
import { renderTextReport, renderInterviewerText } from './report.mjs'

function commonOptions() {
  return {
    source: { type: 'string', default: process.env.SOURCE_URL || DEFAULT_SOURCE_URL },
    provider: { type: 'string', default: process.env.PROVIDER_URL || DEFAULT_PROVIDER_URL },
    state: { type: 'string', default: process.env.WORKBENCH_STATE || DEFAULT_STATE_PATH },
    round: { type: 'string' },
    as: { type: 'string' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
    snapshot: { type: 'string' },
    headless: { type: 'boolean', default: true },
    apply: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    'no-refresh': { type: 'boolean', default: false }
  }
}

async function loadSnapshotFile(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

async function runReconcileFromFile(values) {
  const snapshot = await loadSnapshotFile(values.snapshot)
  const store = await loadStore(values.state)
  const world = reconcile(snapshot, store, { round: values.round, interviewerId: values.as })
  return { snapshot, store, world }
}

async function cmdSync(_positionals, values) {
  const options = {
    sourceUrl: values.source,
    providerUrl: values.provider,
    statePath: values.state,
    round: values.round,
    interviewerId: values.as,
    headless: values.headless,
    refresh: !values['no-refresh']
  }
  if (values.snapshot) {
    const result = await runReconcileFromFile(values)
    if (values.json) console.log(JSON.stringify(result.world, null, 2))
    else console.log(renderTextReport(result.world))
    return
  }
  if (values.apply || values['dry-run']) {
    const result = await applyAutomaticActions({ ...options, dryRun: values['dry-run'] })
    if (values.json) console.log(JSON.stringify({ world: result.world, actions: result.actions, audit: result.audit, dryRun: result.dryRun }, null, 2))
    else {
      console.log(renderTextReport(result.world))
      console.log('\n自动代办审计：')
      for (const row of result.audit) console.log('-', row.type, row.reason || row.action?.type || '')
    }
    return
  }
  const result = await syncWorkbench(options)
  if (values.json) console.log(JSON.stringify(result.world, null, 2))
  else console.log(renderTextReport(result.world))
}

async function cmdCapture(_positionals, values) {
  const desk = await captureDesk(values.source, { headless: values.headless })
  const provider = values.provider === false ? { rooms: [], receipts: [] } : await fetchProviderState(values.provider)
  const snapshot = { ...desk, ...provider }
  if (values.out) await writeFile(values.out, JSON.stringify(snapshot, null, 2))
  console.log(values.out ? `已写入 ${values.out}` : JSON.stringify(snapshot, null, 2))
}

async function cmdInterviewer(_positionals, values) {
  let world
  if (values.snapshot) ({ world } = await runReconcileFromFile(values))
  else ({ world } = await syncWorkbench({
    sourceUrl: values.source, providerUrl: values.provider, statePath: values.state,
    round: values.round, interviewerId: values.as, persist: false
  }))
  const view = values.as
    ? world.interviewerView
    : { ...world.interviewerView, interviewerId: values.as || world.interviewerView.interviewerId }
  if (values.json) console.log(JSON.stringify(view, null, 2))
  else console.log(renderInterviewerText(view))
}

async function cmdTrail(positionals, values) {
  const receipt = positionals[0] || values.receipt
  if (!receipt) throw new Error('请提供原回执号，例如 trail N1')
  const store = await loadStore(values.state)
  const local = findReceiptTrail(store, receipt)
  let remote = null
  try { remote = await fetchReceiptTrail(values.provider, { receipt }) } catch (error) { remote = { error: error.message } }
  const payload = { originalReceipt: receipt, local, remote }
  if (values.json) console.log(JSON.stringify(payload, null, 2))
  else {
    console.log(`沿原号 ${receipt} 查询：`)
    for (const a of local.amendments || []) console.log(`- 本地改期：${a.candidate} / ${a.oldReceipt} -> ${a.newSlot || '-'} / ${a.state}`)
    if (Array.isArray(remote)) for (const r of remote) console.log(`- 外部回执：${r.candidate} / ${r.slot} / ${r.receipt} / ${r.state}${r.by ? ' -> ' + r.by : ''}`)
    else console.log('- 外部查询失败：' + remote.error)
  }
}

async function cmdAmend(positionals, values) {
  const candidate = values.candidate || positionals[0]
  const receipt = values.receipt || positionals[1]
  if (!candidate || !receipt) throw new Error('用法：amend B1 N1')
  const result = await amendNotice(values.provider, { candidate, receipt })
  console.log(JSON.stringify(result, null, 2))
  if (!result.accepted) process.exitCode = 2
}

async function cmdLab(positionals, values) {
  const stage = positionals[0] || values.stage
  if (!stage) throw new Error('用法：lab merged|informed|single')
  console.log(JSON.stringify(await setLabStage(values.provider, stage), null, 2))
}

const HELP = `oral-access 联络员采录与代办

命令：
  sync        用 Chromium 采录 /desk，读取设备与送达回执，输出四类状态（默认）
  capture     仅采录浏览器资料，可用 --out 保存快照
  interviewer 输出面谈官白名单视图，需配合 --as I1
  trail N1    沿原回执/原报名号查询本地轨迹和外部回执
  amend B1 N1 用原报名号和原回执发起改期
  lab merged  切换 provider 演练档 single|merged|informed

常用参数：
  --source URL    默认 http://127.0.0.1:8700
  --provider URL  默认 http://127.0.0.1:8701
  --state FILE    默认 .oral-access/workbench.json
  --round r1      焦点轮次；不传时按外部回执/合并记录推断
  --as I1         面谈官编号
  --apply         执行资格和资源均通过的门户代办/原回执改期
  --dry-run       只列自动动作
  --json          输出 JSON
  --headed        显示浏览器窗口
`

async function main() {
  const command = process.argv[2] || 'sync'
  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP)
    return
  }
  const parsed = parseArgs({
    args: process.argv.slice(3),
    options: {
      ...commonOptions(),
      out: { type: 'string' },
      candidate: { type: 'string' },
      receipt: { type: 'string' },
      stage: { type: 'string' },
      headed: { type: 'boolean', default: false }
    },
    allowPositionals: true
  })
  const values = { ...parsed.values, headless: parsed.values.headed ? false : parsed.values.headless }
  if (values.help) return console.log(HELP)
  const positionals = parsed.positionals
  const commands = {
    sync: cmdSync,
    report: cmdSync,
    capture: cmdCapture,
    interviewer: cmdInterviewer,
    trail: cmdTrail,
    amend: cmdAmend,
    lab: cmdLab
  }
  if (!commands[command]) throw new Error(`未知命令：${command}；可用：${Object.keys(commands).join(', ')}`)
  await commands[command](positionals, values)
}

main().catch(error => {
  console.error(error.stack || error.message)
  process.exit(1)
})
