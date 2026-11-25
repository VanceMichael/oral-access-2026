import { captureDesk } from './browser.mjs'

export const DEFAULT_SOURCE_URL = 'http://127.0.0.1:8700'
export const DEFAULT_PROVIDER_URL = 'http://127.0.0.1:8701'

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } })
  const text = await response.text()
  let body
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  if (!response.ok) {
    const error = new Error(`GET ${url} -> ${response.status}`)
    error.status = response.status
    error.body = body
    throw error
  }
  return body
}

export async function fetchProviderState(providerUrl = DEFAULT_PROVIDER_URL, query = {}) {
  const base = providerUrl.replace(/\/$/, '')
  const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null))
  const suffix = qs.size ? `?${qs}` : ''
  const [roomsResult, receiptsResult] = await Promise.allSettled([
    getJson(`${base}/rooms/confirmations`),
    getJson(`${base}/notices/receipts${suffix}`)
  ])
  return {
    providerUrl: base,
    rooms: roomsResult.status === 'fulfilled' ? roomsResult.value : [],
    receipts: receiptsResult.status === 'fulfilled' ? receiptsResult.value : [],
    errors: [
      roomsResult.status === 'rejected' ? { endpoint: '/rooms/confirmations', error: roomsResult.reason.message } : null,
      receiptsResult.status === 'rejected' ? { endpoint: '/notices/receipts', error: receiptsResult.reason.message } : null
    ].filter(Boolean),
    fetchedAt: new Date().toISOString()
  }
}

export async function fetchReceiptTrail(providerUrl, { candidate, receipt } = {}) {
  const qs = new URLSearchParams()
  if (candidate) qs.set('candidate', candidate)
  if (receipt) qs.set('receipt', receipt)
  const suffix = qs.size ? `?${qs}` : ''
  return getJson(`${providerUrl.replace(/\/$/, '')}/notices/receipts${suffix}`)
}

// 用原报名号和旧通知回执发起改期。202 只代表外部系统收到申请。
export async function amendNotice(providerUrl, { candidate, receipt }) {
  const response = await fetch(providerUrl.replace(/\/$/, '') + '/notices/amend', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ candidate, receipt })
  })
  const text = await response.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return {
    ok: response.ok,
    status: response.status,
    accepted: response.status === 202,
    body,
    // 演练档可能回一个 receipt 字段，但在 receipts 回读确认前，它绝不是新送达通知。
    deliveryConfirmed: false,
    at: new Date().toISOString()
  }
}

export async function setLabStage(providerUrl, stage) {
  const response = await fetch(`${providerUrl.replace(/\/$/, '')}/lab?stage=${encodeURIComponent(stage)}`, { method: 'POST' })
  if (!response.ok) throw new Error(`切换演练档失败: ${response.status}`)
  return response.json()
}

export async function collectSnapshot(options = {}) {
  const sourceUrl = options.sourceUrl || DEFAULT_SOURCE_URL
  const providerUrl = options.providerUrl || DEFAULT_PROVIDER_URL
  const [desk, provider] = await Promise.all([
    options.desk || captureDesk(sourceUrl, options.browserOptions || { headless: options.headless ?? true }),
    options.provider === false ? Promise.resolve({ rooms: [], receipts: [], errors: [] }) : fetchProviderState(providerUrl)
  ])
  return {
    ...desk,
    providerUrl,
    rooms: provider.rooms,
    receipts: provider.receipts,
    providerErrors: provider.errors,
    providerFetchedAt: provider.fetchedAt
  }
}
