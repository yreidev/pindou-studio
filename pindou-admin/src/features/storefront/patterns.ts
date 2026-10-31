import type { Announcement, Pattern, PatternCategory } from '../../api/storefront'

// 「首页内容」页的规则（照后端 internal/modules/patterns 与 internal/app/storefront.go）：图纸名字 1～20 个字，
// 分类名 1～10 个字，公告 200 字以内可以换行；第一次上架起 7 天算上新。

export const newForDays = 7
export const maxPatternName = 20
export const maxCategoryName = 10
export const maxAnnouncement = 200

const length = (text: string) => Array.from(text.trim()).length
const hasControl = (text: string) => /\p{Cc}/u.test(text)

/** 图纸名字不对时的原因。 */
export function patternNameProblem(text: string): string | null {
  if (!length(text)) return '请填图纸名字'
  if (length(text) > maxPatternName || hasControl(text.trim())) return `名字最多 ${maxPatternName} 个字，不能换行`
  return null
}

/** 分类名字不对时的原因；taken 是已有的分类名（改名时不含自己）。 */
export function categoryNameProblem(text: string, taken: readonly string[]): string | null {
  const name = text.trim()
  if (!name) return '请填分类名字'
  if (length(name) > maxCategoryName || hasControl(name)) return `分类名最多 ${maxCategoryName} 个字，不能换行`
  if (taken.includes(name)) return `已经有叫「${name}」的分类了`
  return null
}

/** 公告不对时的原因（空的表示清除，不算错）。 */
export function announcementProblem(text: string): string | null {
  if (length(text) > maxAnnouncement) return `公告最多 ${maxAnnouncement} 个字，现在 ${length(text)} 个`
  if (/[^\P{Cc}\n]/u.test(text.trim())) return '公告里有不能显示的字符'
  return null
}

/** 把 id 往前（-1）或往后（1）挪一位；到头了原样返回。 */
export function moveId(ids: readonly string[], id: string, offset: -1 | 1): string[] {
  const from = ids.indexOf(id)
  const to = from + offset
  const next = [...ids]
  if (from < 0 || to < 0 || to >= ids.length) return next
  ;[next[from], next[to]] = [next[to], next[from]]
  return next
}

/** 上新还剩几天（向上取整，至少 1 天）；不算上新返回 null。 */
export function newDaysLeft(pattern: Pick<Pattern, 'isNew' | 'firstPublishedAt'>, now: Date): number | null {
  if (!pattern.isNew || !pattern.firstPublishedAt) return null
  const end = new Date(pattern.firstPublishedAt).getTime() + newForDays * 24 * 3600 * 1000
  return Math.max(1, Math.ceil((end - now.getTime()) / (24 * 3600 * 1000)))
}

/** 图纸的分类名：不分类、已停用的都写明。 */
export function categoryLabel(categories: readonly PatternCategory[], id: string | null): string {
  if (!id) return '不分类'
  const category = categories.find((item) => item.id === id)
  if (!category) return '不分类'
  return category.enabled ? category.name : `${category.name}（已停用）`
}

/** 每个分类里有几张图纸（含下架的）。 */
export function patternCounts(patterns: readonly Pattern[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const pattern of patterns) {
    if (pattern.categoryId) counts.set(pattern.categoryId, (counts.get(pattern.categoryId) ?? 0) + 1)
  }
  return counts
}

/** 公告现在的状态：没有、顾客看得到、已过期（顾客看不到了）。 */
export function announcementStatus(announcement: Announcement | null): {
  label: string
  color: 'grey' | 'green' | 'orange'
} {
  if (!announcement) return { label: '没有公告', color: 'grey' }
  if (announcement.expired) return { label: '已过期，顾客看不到了', color: 'orange' }
  return {
    label: announcement.expiresOn ? `首页显示中，显示到 ${announcement.expiresOn}` : '首页显示中，不过期',
    color: 'green',
  }
}
