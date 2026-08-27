// dsh-smart-router — 会话日志验证脚本
// 读最近（或指定）会话的 session.jsonl.zstd，展示：
//   - request/header 模型变更（路由是否生效）
//   - smart-router/ledger 账本（路由决策记录）
//   - smart-router-p0/* 挂钩点观测（P0 验证）
// 用法：node scripts/verify.mjs [sessionId]
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const sessionsRoot = path.join(os.homedir(), '.dsh', 'sessions')
const target = process.argv[2]

const ZSTD_MAGIC = 4247762216

function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) break
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`corrupt zstd: invalid frame magic at byte ${offset}`)
    offset += 4
    if (offset === buffer.length) break
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`corrupt zstd: reserved frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) break
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return frames
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = blockHeader >>> 1 & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`corrupt zstd: reserved block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return frames
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) break
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

function readLog(dir) {
  const zstdPath = path.join(dir, 'session.jsonl.zstd')
  const plainPath = path.join(dir, 'session.jsonl')
  if (fs.existsSync(zstdPath)) {
    const buf = fs.readFileSync(zstdPath)
    const parts = []
    for (const { start, end } of scanZstdFrames(buf)) {
      try { parts.push(zstdDecompressSync(buf.subarray(start, end)).toString('utf8')) } catch { /* skip */ }
    }
    return parts.join('')
  }
  if (fs.existsSync(plainPath)) return fs.readFileSync(plainPath, 'utf8')
  return null
}

function findLatestSession() {
  let latest = null
  let latestTime = 0
  const walk = (dir, depth) => {
    if (depth > 4) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name.startsWith('session-')) {
          let st
          try { st = fs.statSync(full) } catch { continue }
          if (st.mtimeMs > latestTime) { latestTime = st.mtimeMs; latest = full }
        } else walk(full, depth + 1)
      }
    }
  }
  walk(sessionsRoot, 0)
  return latest
}

const sessionDir = target
  ? (path.isAbsolute(target) ? target : path.join(sessionsRoot, target))
  : findLatestSession()
if (!sessionDir) { console.error('no session found'); process.exit(1) }
console.log('session:', sessionDir)

const log = await readLog(sessionDir)
if (!log) { console.error('no session log found'); process.exit(1) }

const lines = log.split('\n').filter(Boolean)
console.log('total events:', lines.length)

const headers = []
const ledger = []
const p0 = []
for (const line of lines) {
  let ev
  try { ev = JSON.parse(line) } catch { continue }
  if (ev.type === 'request/header') {
    headers.push({ reason: ev.data?.reason, provider: ev.data?.header?.config?.provider, model: ev.data?.header?.config?.model, effort: ev.data?.header?.config?.reasoningEffort })
  } else if (ev.type === 'smart-router/ledger') {
    ledger.push(ev.data)
  } else if (typeof ev.type === 'string' && ev.type.startsWith('smart-router-p0/')) {
    p0.push({ type: ev.type, data: ev.data })
  }
}

console.log('\n=== request/header（模型路由）===')
for (const h of headers) console.log(`  [${h.reason}] ${h.provider}/${h.model}${h.effort ? ' effort=' + h.effort : ''}`)

console.log('\n=== smart-router 账本（路由决策）===')
if (ledger.length === 0) console.log('  （无路由决策记录）')
else for (const e of ledger) console.log(`  ${new Date(e.at).toLocaleTimeString()} -> ${e.route} (${e.trigger}, light=${e.light ?? '-'} heavy=${e.heavy ?? '-'} len=${e.len ?? '-'})`)

console.log('\n=== P0 挂钩点观测 ===')
if (p0.length === 0) {
  console.log('  （无 —— smart-router-p0 未加载或该会话在其加载前产生）')
} else {
  const byType = {}
  for (const e of p0) byType[e.type] = (byType[e.type] ?? 0) + 1
  for (const [t, n] of Object.entries(byType)) console.log(`  ${t}: ${n}`)
  const lastAssemble = p0.filter((e) => e.type === 'smart-router-p0/assemble').pop()
  if (lastAssemble) console.log('  最近 assemble:', JSON.stringify(lastAssemble.data).slice(0, 300))
}
