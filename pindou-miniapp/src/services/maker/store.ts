import Taro from '@tarojs/taro'
import type { StaffError } from '../staff'
import { beadApi, type BeadPattern, type BeadPatternInput } from './api'
import {
  beadCounts,
  cleanName,
  compact,
  decodeCells,
  decodeDone,
  encodeCells,
  encodeDone,
  fromBase64,
  toBase64,
  type Grid,
} from './grid'

// 图纸存在哪（docs/plan-bead-maker.md 第 3 节 9、第 4 节）：
// - 每改一步存在手机上（setStorage）：没网也能做、能改，切出去或闪退回来还在。锁住的格子只存在手机上。
// - 存进「我的图纸」（要登录）以后，每次改完几秒内同步进账户：PATCH 带读到的修订号，别处先改了回 409，让顾客选用哪份，不覆盖。
// - 手机上只留最近的几张：没存进账户的最多 3 张（再新做就挤掉最旧的），账户里的图纸在手机上的副本最多 12 张（只挤掉已同步的）。

export type { BeadPattern } from './api'

export type Draft = {
  id: string
  name: string
  grid: Grid
  done: Uint8Array
  locked: Uint8Array
  /** 账户里的修订号；0 是还没存进账户 */
  revision: number
  /** 存进了「我的图纸」：以后每改一步都同步 */
  inAccount: boolean
  /** 有改动还没同步进账户 */
  dirty: boolean
  /** 手机上最后一次改的时刻（毫秒） */
  updatedAt: number
}

type Stored = {
  v: 1
  id: string
  name: string
  palette: string
  width: number
  height: number
  colors: string[]
  cells: string
  done: string
  locked: string
  revision: number
  inAccount: boolean
  dirty: boolean
  updatedAt: number
}

export type StoragePort = {
  get: (key: string) => unknown
  set: (key: string, value: unknown) => void
  remove: (key: string) => void
}

export const deviceStorage: StoragePort = {
  get: (key) => Taro.getStorageSync(key),
  set: (key, value) => Taro.setStorageSync(key, value),
  remove: (key) => Taro.removeStorageSync(key),
}

const indexKey = 'maker:drafts'
const draftKey = (id: string) => `maker:draft:${id}`
export const LOCAL_ONLY_LIMIT = 3
export const CACHE_LIMIT = 12

/** 索引里每张的摘要：挤掉哪张、底部「图纸」显示几张拼到多少，都不用把整张图纸读出来。 */
export type LocalSummary = {
  id: string
  name: string
  inAccount: boolean
  dirty: boolean
  updatedAt: number
  beads: number
  doneBeads: number
}

/** 手机上的图纸摘要，最近改的在前。 */
export function localIndex(port: StoragePort): LocalSummary[] {
  let raw: unknown
  try {
    raw = port.get(indexKey)
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (v): v is LocalSummary => !!v && typeof v === 'object' && typeof (v as LocalSummary).id === 'string',
  )
}

function summary(d: Draft): LocalSummary {
  const c = beadCounts(d.grid, d.done)
  return {
    id: d.id,
    name: d.name,
    inAccount: d.inAccount,
    dirty: d.dirty,
    updatedAt: d.updatedAt,
    beads: c.beads,
    doneBeads: c.done,
  }
}

function encode(d: Draft): Stored {
  return {
    v: 1,
    id: d.id,
    name: d.name,
    palette: d.grid.palette,
    width: d.grid.width,
    height: d.grid.height,
    colors: d.grid.colors,
    cells: encodeCells(d.grid.cells),
    done: encodeDone(d.grid, d.done),
    locked: d.locked.some((v) => v) ? toBase64(packBits(d.locked)) : '',
    revision: d.revision,
    inAccount: d.inAccount,
    dirty: d.dirty,
    updatedAt: d.updatedAt,
  }
}

function decode(s: unknown): Draft | undefined {
  if (!s || typeof s !== 'object') return undefined
  const o = s as Stored
  if (o.v !== 1 || typeof o.id !== 'string' || !Array.isArray(o.colors)) return undefined
  const cells =
    typeof o.cells === 'string' && o.cells.length === o.width * o.height
      ? decodeCells(o.cells, o.colors.length)
      : undefined
  if (!cells) return undefined
  const grid: Grid = { width: o.width, height: o.height, palette: o.palette, colors: [...o.colors], cells }
  const done = decodeDone(grid, o.done || '')
  const lockBits = o.locked ? fromBase64(o.locked) : undefined
  return {
    id: o.id,
    name: o.name,
    grid,
    done: done ?? new Uint8Array(Math.ceil(cells.length / 8)),
    locked: lockBits ? unpackBits(lockBits, cells.length) : new Uint8Array(cells.length),
    revision: o.revision || 0,
    inAccount: Boolean(o.inAccount),
    dirty: Boolean(o.dirty),
    updatedAt: o.updatedAt || 0,
  }
}

function packBits(flags: Uint8Array) {
  const out = new Uint8Array(Math.ceil(flags.length / 8))
  flags.forEach((v, i) => {
    if (v) out[i >> 3] |= 1 << (i & 7)
  })
  return out
}
function unpackBits(bits: Uint8Array, n: number) {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = (bits[i >> 3] >> (i & 7)) & 1
  return out
}

/** 存在手机上，挪到最前；超出上限的旧图纸挤掉（没同步完的账户图纸不挤）。存储满了抛错，页面提示。 */
export function saveLocal(port: StoragePort, d: Draft) {
  port.set(draftKey(d.id), encode(d))
  const order = [summary(d), ...localIndex(port).filter((m) => m.id !== d.id)]
  let localOnly = 0,
    cached = 0
  const keep: LocalSummary[] = []
  for (const m of order) {
    const over = m.inAccount ? !m.dirty && ++cached > CACHE_LIMIT : ++localOnly > LOCAL_ONLY_LIMIT
    if (over) port.remove(draftKey(m.id))
    else keep.push(m)
  }
  port.set(indexKey, keep)
}

export const loadLocal = (port: StoragePort, id: string) => decode(port.get(draftKey(id)))

/** 手机上的图纸，最近改的在前。 */
export function localDrafts(port: StoragePort): Draft[] {
  return localIndex(port)
    .map((m) => loadLocal(port, m.id))
    .filter((d): d is Draft => Boolean(d))
}

export function removeLocal(port: StoragePort, id: string) {
  port.remove(draftKey(id))
  port.set(
    indexKey,
    localIndex(port).filter((m) => m.id !== id),
  )
}

/** 存进账户的内容：去掉没用到的颜色（序号会变，手机上的不变）。 */
export function toInput(d: Draft): BeadPatternInput {
  const g = compact(d.grid)
  return {
    expectedRevision: d.revision,
    name: d.name,
    palette: g.palette,
    width: g.width,
    height: g.height,
    colors: g.colors,
    cells: encodeCells(g.cells),
    done: encodeDone(g, d.done),
  }
}

/** 账户里读回来的图纸变成手机上的样子；锁住的格子只在手机上，换手机后没有。 */
export function fromServer(p: BeadPattern, locked?: Uint8Array): Draft | undefined {
  const cells = decodeCells(p.cells, p.colors.length)
  if (!cells || cells.length !== p.width * p.height) return undefined
  const grid: Grid = { width: p.width, height: p.height, palette: p.palette, colors: [...p.colors], cells }
  return {
    id: p.id,
    name: p.name,
    grid,
    done: decodeDone(grid, p.done) ?? new Uint8Array(Math.ceil(cells.length / 8)),
    locked: locked && locked.length === cells.length ? locked : new Uint8Array(cells.length),
    revision: p.revision,
    inAccount: true,
    dirty: false,
    updatedAt: Date.parse(p.updatedAt) || Date.now(),
  }
}

export type SyncResult =
  /** 存好了 */
  | { status: 'saved'; revision: number }
  /** 没网、没登录或太频繁：先存在手机上，下次再同步 */
  | { status: 'later'; message: string }
  /** 别处改过（或删了）：让顾客选用哪份 */
  | { status: 'conflict' }
  /** 账户里已经存满 30 张 */
  | { status: 'full' }
  /** 内容不合规矩（不该发生）：显示原因 */
  | { status: 'invalid'; message: string }

/**
 * 同步一张图纸进账户。成功后修订号更新；同步途中顾客又改了（updatedAt 变了）就还算没同步完。
 * 结果写回手机上的副本。
 */
export async function sync(
  port: StoragePort,
  d: Draft,
  api: Pick<typeof beadApi, 'save'> = beadApi,
): Promise<SyncResult> {
  const startedAt = d.updatedAt
  const name = cleanName(d.name)
  if (!name) return { status: 'invalid', message: '图纸名字要 1～20 个字' }
  try {
    const saved = await api.save(d.id, toInput({ ...d, name }))
    d.revision = saved.revision
    d.inAccount = true
    d.dirty = d.updatedAt !== startedAt
    saveLocal(port, d)
    return { status: 'saved', revision: saved.revision }
  } catch (error) {
    const e = error as StaffError
    if (e?.code === 'bead_pattern_conflict' || (e?.status === 404 && d.revision > 0)) return { status: 'conflict' }
    if (e?.code === 'bead_pattern_limit') return { status: 'full' }
    if (e?.status === 400) return { status: 'invalid', message: e.message }
    return { status: 'later', message: e?.message || '网络连接失败，稍后自动再存' }
  }
}

/** 冲突时用手机上这份：读账户里最新的修订号再存一次（账户里那份被删了就当新建）。 */
export async function keepMine(port: StoragePort, d: Draft, api: Pick<typeof beadApi, 'get' | 'save'> = beadApi) {
  try {
    d.revision = (await api.get(d.id)).revision
  } catch (error) {
    if ((error as StaffError)?.status !== 404) throw error
    d.revision = 0
  }
  return sync(port, d, api)
}

/** 冲突时用账户里那份：读回来盖掉手机上的（锁住的格子留着，格数变了就不留）。 */
export async function takeTheirs(port: StoragePort, d: Draft, api: Pick<typeof beadApi, 'get'> = beadApi) {
  const fresh = fromServer(await api.get(d.id), d.locked)
  if (!fresh) throw new Error('账户里的图纸读不出来')
  saveLocal(port, fresh)
  return fresh
}

/**
 * 打开账户里的一张：手机上有没同步完的副本、而且是从同一个修订号改起的，用手机上的（接着同步）；
 * 账户里的更新、手机上又有没同步的改动，回 conflict 让顾客选；否则用账户里的。
 */
export function pickCopy(
  server: BeadPattern,
  local: Draft | undefined,
): { draft: Draft; conflict: boolean } | undefined {
  if (local && local.dirty && local.revision === server.revision) return { draft: local, conflict: false }
  const fresh = fromServer(server, local?.locked)
  if (!fresh) return undefined
  if (local && local.dirty && local.revision !== server.revision) return { draft: local, conflict: true }
  return { draft: fresh, conflict: false }
}
