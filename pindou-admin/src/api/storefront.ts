import { queryOptions } from '@tanstack/react-query'
import { client, idempotencyKey, read, type Schemas } from './client'

// 小程序首页的内容（迁移 025，方案见 docs/plan-home-and-patterns.md）：图纸、图纸分类、首页公告。所有员工都能改。
// 图纸和分类的写接口都回整个图纸库，页面直接拿它替换缓存，不自己拼。推送的资源名是 patterns、storefront。

export type PatternLibrary = Schemas['PatternLibrary']
export type Pattern = Schemas['Pattern']
export type PatternCategory = Schemas['PatternCategory']
export type PatternInput = Schemas['PatternInput']
export type PatternUpdate = Schemas['PatternUpdate']
export type PatternCategoryUpdate = Schemas['PatternCategoryUpdate']
export type AnnouncementView = Schemas['AnnouncementView']
export type Announcement = NonNullable<AnnouncementView['announcement']>
export type AnnouncementInput = Schemas['AnnouncementInput']

export const storefrontApi = {
  /** 员工看的全部：含下架的图纸和停用的分类。 */
  library: (signal?: AbortSignal) => read(client.GET('/patterns', { params: { query: { scope: 'all' } }, signal })),
  /** 上传一张，排在最前面。要幂等键：网络重试不会传出两张。 */
  upload: (body: PatternInput) => read(client.POST('/patterns', { params: { header: idempotencyKey() }, body })),
  update: (patternId: string, body: PatternUpdate) =>
    read(client.PATCH('/patterns/{patternId}', { params: { path: { patternId } }, body })),
  remove: (patternId: string) => read(client.DELETE('/patterns/{patternId}', { params: { path: { patternId } } })),
  /** 给出全部图纸的新顺序；别人刚增删过时回 409 order_outdated。 */
  order: (ids: string[]) => read(client.PATCH('/pattern-order', { body: { ids } })),
  addCategory: (name: string) => read(client.POST('/pattern-categories', { body: { name } })),
  updateCategory: (categoryId: string, body: PatternCategoryUpdate) =>
    read(client.PATCH('/pattern-categories/{categoryId}', { params: { path: { categoryId } }, body })),
  /** 只删空分类（含下架的图纸也算有图纸）；还有图纸时回 409 pattern_category_in_use。 */
  removeCategory: (categoryId: string) =>
    read(client.DELETE('/pattern-categories/{categoryId}', { params: { path: { categoryId } } })),
  orderCategories: (ids: string[]) => read(client.PATCH('/pattern-category-order', { body: { ids } })),
  /** 编辑用的公告：含已过期的。 */
  announcement: (signal?: AbortSignal) => read(client.GET('/storefront/announcement', { signal })),
  /** 保存公告；空文字表示清除。 */
  saveAnnouncement: (body: AnnouncementInput) => read(client.PATCH('/storefront/announcement', { body })),
}

export function patternLibraryQuery() {
  return queryOptions({ queryKey: ['patterns'], queryFn: ({ signal }) => storefrontApi.library(signal) })
}

export function announcementQuery() {
  return queryOptions({
    queryKey: ['storefront', 'announcement'],
    queryFn: ({ signal }) => storefrontApi.announcement(signal),
  })
}

/** 图片地址：接口给的路径相对接口根地址（/api/v2），带着图片版本，换图后浏览器不再用旧缓存。 */
export function patternImageUrl(path: string): string {
  return `/api/v2${path}`
}
