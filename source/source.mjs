import http from 'node:http'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const source = JSON.parse(await readFile(new URL('../records/source.json', import.meta.url), 'utf8'))
const pageRows = 2
const quote = value => String(value).replace(/[&<>"']/g, char => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
))
const id = value => createHash('sha256').update(value).digest('hex').slice(0, 16)

function send(response, code, type, body, headers = {}) {
  response.writeHead(code, { 'Content-Type': type, ...headers })
  response.end(body)
}

function json(response, code, data, headers) {
  send(response, code, 'application/json; charset=utf-8', JSON.stringify(data), headers)
}

function table(name, rows) {
  const body = rows.map(cols => '<tr>' + cols.map(x => '<td>' + quote(x) + '</td>').join('') + '</tr>').join('')
  return '<table aria-label="' + quote(name) + '"><caption>' + quote(name) + '</caption><tbody>' + body + '</tbody></table>'
}

function html(response, code, body) {
  send(response, code, 'text/html; charset=utf-8',
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>' +
    quote(source.title) + '</title><h1>' + quote(source.title) + '</h1>' + body + '</html>')
}

function pageLink(url, cursor) {
  const output = new URL(url)
  output.searchParams.set('cursor', cursor)
  return output.pathname + output.search
}

function editionData(name) {
  return source.editions.find(release => release.edition === name)
}

function pageOf(url, name, edition) {
  const allRows = edition.streams[name]
  if (!allRows) return { code: 404 }
  const key = url.searchParams.get('key')
  const from = url.searchParams.get('from')
  const until = url.searchParams.get('until')
  const filter = source.filters[name]
  if (((from !== null || until !== null) && filter?.clock === undefined) || (key !== null && !filter)) {
    return { code: 422 }
  }
  if ((from !== null && !/^-?\d+$/.test(from)) || (until !== null && !/^-?\d+$/.test(until))) {
    return { code: 422 }
  }
  const visible = allRows.filter(row =>
    (key === null || row[filter.key] === key) &&
    (from === null || Number(row[filter.clock]) >= Number(from)) &&
    (until === null || Number(row[filter.clock]) < Number(until))
  )
  const fingerprint = id(JSON.stringify([edition.edition, name, key, from, until]))
  const cursors = visible.map((_, i) => id(fingerprint + ':' + i))
  const cursor = url.searchParams.get('cursor')
  const offset = cursor === null ? 0 : cursors.indexOf(cursor)
  if (offset < 0) return { code: 409 }
  const next = offset + pageRows
  return {
    code: 200,
    rows: visible.slice(offset, next),
    headers: next < visible.length ? { Link: '<' + pageLink(url, cursors[next]) + '>; rel="next"' } : {},
    fingerprint: id(JSON.stringify([fingerprint, visible, offset]))
  }
}

function browserPage(response, url, edition, changes, message = '') {
  const nav = Object.keys(edition.streams).map(stream =>
    '<a href="/desk?view=' + encodeURIComponent(stream) + '">' + quote(stream) + '</a>').join(' ')
  const view = url.searchParams.get('view') || Object.keys(edition.streams)[0]
  if (!Object.hasOwn(edition.streams, view)) return html(response, 404, '<p>未找到资料视图</p>')
  const selected = pageOf(url, view, edition)
  if (selected.code !== 200) return html(response, selected.code, '<p>请重新选择资料视图</p>')
  const next = selected.headers.Link?.split('>')[0].slice(1)
  const label = source.portal.labels
  const fields = ['scope', 'ref', 'value'].map((name, i) =>
    '<label>' + label[i] + '<input required name="' + name + '"></label>').join('')
  const proofs = [...changes.values()].map(row => [row.scope, row.ref, row.value, row.state, row.receipt])
  return html(response, 200,
    '<p>资料版 <output aria-label="资料版">' + quote(edition.edition) + '</output></p>' +
    (message ? '<p role="status">' + quote(message) + '</p>' : '') +
    '<nav aria-label="业务视图">' + nav + '</nav>' + table(view, selected.rows) +
    (next ? '<a href="' + quote(next) + '">下一页</a>' : '') +
    '<form method="post" action="/desk">' + fields +
    '<input type="hidden" name="edition" value="' + quote(edition.edition) + '">' +
    source.portal.actions.map(([value, name]) => '<button name="action" value="' + value + '">' + quote(name) + '</button>').join('') +
    '</form>' + table('本次门户操作', proofs))
}

async function changeForm(request, response, url, edition, changes) {
  let incoming = ''
  for await (const chunk of request) {
    incoming += chunk
    if (incoming.length > 8192) return html(response, 413, '<p>表单过大</p>')
  }
  const form = new URLSearchParams(incoming)
  const item = Object.fromEntries(['edition', 'scope', 'ref', 'value', 'action'].map(name => [name, form.get(name)]))
  if (item.edition !== edition.edition) return html(response, 409, '<p>资料版已更换</p><a href="/desk">返回</a>')
  if (![item.scope, item.ref, item.value].every(Boolean)) return html(response, 422, '<p>资料不全</p>')
  const key = JSON.stringify([item.scope, item.ref])
  const current = changes.get(key)
  if (source.portal.initialLock) {
    const [stream, scope, reference, status, locked] = source.portal.initialLock
    const row = edition.streams[stream].find(row => (scope === null || row[scope] === item.scope) && row[reference] === item.ref && row[status] === locked)
    if (row) return browserPage(response, url, edition, changes, '该记录已经由业务方确认')
  }
  const exactDraft = current?.value === item.value && current.edition === item.edition
  if (current?.state === 'confirmed') return browserPage(response, url, edition, changes, '已有确认回执')
  if (item.action === 'draft') {
    changes.set(key, { ...item, state: 'draft', receipt: '' })
  } else if (item.action === 'review' && exactDraft && current.state === 'draft') {
    changes.set(key, { ...current, state: 'reviewed' })
  } else if (item.action === 'confirm' && exactDraft && current.state === 'reviewed') {
    changes.set(key, { ...current, state: 'confirmed', receipt: 'RC-' + id(key + ':' + item.value + ':' + item.edition) })
  } else {
    return html(response, 409, '<p>暂存或校验已失效</p><a href="/desk">返回</a>')
  }
  return browserPage(response, url, edition, changes, '登记已更新')
}

export function createSource() {
  let selected = source.editions[0]
  const changes = new Map()
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost')
      if (url.pathname === '/health') return json(response, 200, { edition: selected.edition })
      if (url.pathname === '/control' && request.method === 'POST') {
        const release = editionData(url.searchParams.get('edition'))
        if (!release) return json(response, 404, { error: '没有该资料版' })
        selected = release
        return json(response, 200, { edition: selected.edition })
      }
      if (source.browser && url.pathname === '/desk') {
        if (request.method === 'POST') return await changeForm(request, response, url, selected, changes)
        if (request.method === 'GET') return browserPage(response, url, selected, changes)
      }
      if (request.method !== 'GET') return json(response, 405, { error: '不支持该操作' })
      return json(response, 404, { error: '没有该资料' })
    } catch (error) {
      return json(response, 500, { error: error.message })
    }
  })
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createSource().listen(Number(process.env.PORT || 8700), '127.0.0.1', () => {
    console.log('资料来源已启动')
  })
}
