import type { BeadPatternList } from './api'
import { progress } from './boards'
import type { LocalSummary } from './store'

// 底部「图纸」和「本次手作」上的「我的图纸」一行：几张、最近改的那张拼到多少。
// 登录了是账户里的加上账户里还没有的；没登录只有手机上的（含以前存进账户、手机上还留着的副本）。

export type MineEntry = { id: string; name: string; updatedAt: number; beads: number; doneBeads: number }

export function myPatterns(list: BeadPatternList | null | undefined, local: LocalSummary[]) {
  const ids = new Set(list?.patterns.map((p) => p.id))
  const all: MineEntry[] = list
    ? [
        ...list.patterns.map((p) => ({
          id: p.id,
          name: p.name,
          updatedAt: Date.parse(p.updatedAt),
          beads: p.beads,
          doneBeads: p.doneBeads,
        })),
        // 账户里还没有的：只在手机上的，和点了存进账户还没存上的
        ...local.filter((m) => !ids.has(m.id)),
      ]
    : local
  const latest = all.reduce<MineEntry | undefined>((a, b) => (!a || b.updatedAt > a.updatedAt ? b : a), undefined)
  return { count: all.length, latest, latestProgress: latest ? progress(latest.beads, latest.doneBeads) : 0 }
}
