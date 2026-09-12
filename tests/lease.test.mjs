/**
 * 生命周期租约单测（2026-09-12 双重重启事故修复）
 *
 * 关键样本是**尸体样本**：用 22:33 那次真实事故的时刻表喂进去——
 * 哨兵 22:33:13 取租约动手，守护 22:33:35 巡检时**必须让位**（不得再拉起、不得再唤醒）。
 * 若这条不成立，本次修复就是假的。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LEASE_TTL_MS, decideLeaseGate, parseLease, readLease, writeLease, clearLease,
  checkLeaseFor, leasePath,
} from '../lib/lease.js'

const withTmp = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'lease-test-'))
  try { return fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

// 事故现场（.watch-events.log 22:33）
const T_KILL = Date.parse('2026-09-12T22:33:13+08:00')
const T_GUARDIAN_CHECK = Date.parse('2026-09-12T22:33:35+08:00')
const T_LATE = Date.parse('2026-09-12T22:40:00+08:00')

describe('decideLeaseGate · 纯裁决', () => {
  const sentinelHeld = { owner: 'sentinel', atMs: T_KILL, ttlMs: LEASE_TTL_MS, note: 'hot-reload' }

  test('尸体样本：哨兵持有租约时，守护在 22:33:35 必须让位', () => {
    const g = decideLeaseGate(sentinelHeld, T_GUARDIAN_CHECK, 'guardian')
    assert.equal(g.action, 'hold')
    assert.equal(g.holder, 'sentinel')
    assert.match(g.why, /held-by-sentinel/)
    assert.ok(g.remainingMs > 0 && g.remainingMs <= LEASE_TTL_MS)
  })

  test('持租方自己不受影响（哨兵继续自己的重启周期）', () => {
    assert.equal(decideLeaseGate(sentinelHeld, T_GUARDIAN_CHECK, 'sentinel').action, 'proceed')
    assert.match(decideLeaseGate(sentinelHeld, T_GUARDIAN_CHECK, 'sentinel').why, /self-held/)
  })

  test('租约过期 → 守护接管（发起者崩溃不得永久锁死服务）', () => {
    const g = decideLeaseGate(sentinelHeld, T_LATE, 'guardian')
    assert.equal(g.action, 'proceed')
    assert.match(g.why, /lease-expired\(age=\d+ms>=ttl=120000ms,holder=sentinel\)/)
  })

  test('无租约 → 放行（no-lease）', () => {
    assert.deepEqual(decideLeaseGate(null, T_GUARDIAN_CHECK, 'guardian'), { action: 'proceed', why: 'no-lease' })
  })

  test('边界：恰好等于 TTL 即过期（不因毫秒误差卡住）', () => {
    const at = T_KILL + LEASE_TTL_MS
    assert.equal(decideLeaseGate(sentinelHeld, at, 'guardian').action, 'proceed')
    assert.equal(decideLeaseGate(sentinelHeld, at - 1, 'guardian').action, 'hold')
  })

  test('时钟偏移（atMs 在未来）→ 放行而非锁死', () => {
    const g = decideLeaseGate({ owner: 'sentinel', atMs: T_GUARDIAN_CHECK + 60_000, ttlMs: LEASE_TTL_MS }, T_GUARDIAN_CHECK, 'guardian')
    assert.equal(g.action, 'proceed')
    assert.match(g.why, /clock-skew/)
  })
})

describe('parseLease · 结构校验', () => {
  test('合法租约保留 note', () => {
    const l = parseLease({ owner: 'guardian', atMs: 1, ttlMs: 2, note: 'x' })
    assert.deepEqual(l, { owner: 'guardian', atMs: 1, ttlMs: 2, note: 'x' })
  })
  for (const [name, bad] of [
    ['未知 owner', { owner: 'someone', atMs: 1, ttlMs: 2 }],
    ['atMs 非数', { owner: 'sentinel', atMs: 'x', ttlMs: 2 }],
    ['ttlMs<=0', { owner: 'sentinel', atMs: 1, ttlMs: 0 }],
    ['非对象', 'nope'],
    ['null', null],
  ]) test('非法即 null：' + name, () => assert.equal(parseLease(bad), null))
})

describe('文件层 · 取租/让位/释放', () => {
  test('取租 → 对方查得到并让位 → 持租方自清 → 恢复空闲', () => {
    withTmp((dir) => {
      writeLease(dir, { owner: 'sentinel', atMs: Date.now(), ttlMs: LEASE_TTL_MS, note: 'daemon_restart' })
      const g = checkLeaseFor(dir, 'guardian', Date.now())
      assert.equal(g.action, 'hold')
      assert.equal(clearLease(dir, 'sentinel').cleared, true)
      assert.equal(checkLeaseFor(dir, 'guardian', Date.now()).action, 'proceed')
    })
  })

  test('不得夺权：guardian 清不掉 sentinel 的租约', () => {
    withTmp((dir) => {
      writeLease(dir, { owner: 'sentinel', atMs: Date.now(), ttlMs: LEASE_TTL_MS })
      const r = clearLease(dir, 'guardian')
      assert.equal(r.cleared, false)
      assert.match(r.why, /not-owner/)
      assert.equal(readLease(dir).lease?.owner, 'sentinel')
    })
  })

  test('尸体样本：损坏的租约文件不得锁死服务（按空闲处理 + 落盘 issue）', () => {
    withTmp((dir) => {
      writeFileSync(leasePath(dir), '{ not json', 'utf8')
      const r = readLease(dir)
      assert.equal(r.lease, null)
      assert.match(r.issue, /lease-json-invalid/)
      const g = checkLeaseFor(dir, 'guardian', Date.now())
      assert.equal(g.action, 'proceed')
      assert.match(g.issue, /lease-json-invalid/)   // 放行但**必须**留下问题证据（不许静默）
    })
  })

  test('空文件按空闲 + issue；缺文件按空闲且无 issue', () => {
    withTmp((dir) => {
      writeFileSync(leasePath(dir), '   ', 'utf8')
      assert.equal(readLease(dir).issue, 'lease-empty')
      rmSync(leasePath(dir))
      assert.equal(readLease(dir).issue, undefined)
    })
  })

  test('释放写证据而非删文件（保留最后一次交接留痕）', () => {
    withTmp((dir) => {
      writeLease(dir, { owner: 'sentinel', atMs: Date.now(), ttlMs: LEASE_TTL_MS })
      assert.equal(clearLease(dir, 'sentinel').cleared, true)
      const raw = JSON.parse(readFileSync(leasePath(dir), 'utf8'))
      assert.equal(raw.owner, 'sentinel')
      assert.equal(raw.ttlMs, 1)
      assert.match(raw.note, /^released-at-\d+$/)
      assert.equal(readLease(dir).lease.ttlMs, 1)   // ttl 1ms → 立即过期 → 闲置
      assert.equal(checkLeaseFor(dir, 'guardian', Date.now()).action, 'proceed')
    })
  })
})
