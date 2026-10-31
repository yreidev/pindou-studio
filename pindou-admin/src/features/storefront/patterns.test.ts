import { describe, expect, it } from 'vitest'
import type { Pattern, PatternCategory } from '../../api/storefront'
import { dataUrlBytes, fileProblem, fitSize, nameFromFile } from './image'
import {
  announcementProblem,
  announcementStatus,
  categoryLabel,
  categoryNameProblem,
  moveId,
  newDaysLeft,
  patternCounts,
  patternNameProblem,
} from './patterns'

const categories: PatternCategory[] = [
  { id: 'c1', name: '水果', enabled: true },
  { id: 'c2', name: '花草', enabled: false },
]

const pattern = (over: Partial<Pattern>): Pattern => ({
  id: 'p1',
  name: '草莓',
  categoryId: 'c1',
  published: true,
  isNew: false,
  firstPublishedAt: null,
  width: 600,
  height: 600,
  updatedAt: '2026-10-20T02:00:00Z',
  imagePath: '/pattern-images/p1/full?v=a',
  thumbnailPath: '/pattern-images/p1/thumb?v=a',
  ...over,
})

describe('上传前缩图', () => {
  it('只收 5 MB 以内的 JPG、PNG', () => {
    expect(fileProblem({ type: 'image/png', size: 1024 })).toBeNull()
    expect(fileProblem({ type: 'image/jpeg', size: 5 * 1024 * 1024 })).toBeNull()
    expect(fileProblem({ type: 'image/gif', size: 1024 })).toBe('只能上传 JPG 或 PNG 图片')
    expect(fileProblem({ type: 'image/png', size: 5 * 1024 * 1024 + 1 })).toBe('图片不能超过 5 MB，请先压缩一下')
    expect(fileProblem({ type: 'image/png', size: 0 })).toBe('这个文件是空的')
  })

  it('长边缩到 1600，等比、不放大', () => {
    expect(fitSize(4000, 3000)).toEqual({ width: 1600, height: 1200 })
    expect(fitSize(900, 3600)).toEqual({ width: 400, height: 1600 })
    expect(fitSize(800, 600)).toEqual({ width: 800, height: 600 })
  })

  it('按 base64 算出图片本身的字节数；文件名去掉扩展名当默认名字', () => {
    expect(dataUrlBytes('data:image/png;base64,AAAA')).toBe(3)
    expect(dataUrlBytes('data:image/png;base64,AAA=')).toBe(2)
    expect(dataUrlBytes('data:image/png;base64,AA==')).toBe(1)
    expect(nameFromFile('草莓小熊.final.png')).toBe('草莓小熊.final')
    expect(nameFromFile(`${'莓'.repeat(30)}.jpg`)).toBe('莓'.repeat(20))
  })
})

describe('首页内容', () => {
  it('名字的规则照后端：图纸 1～20 个字，分类 1～10 个字且不重名', () => {
    expect(patternNameProblem(' 草莓 ')).toBeNull()
    expect(patternNameProblem('  ')).toBe('请填图纸名字')
    expect(patternNameProblem('莓'.repeat(21))).toBe('名字最多 20 个字，不能换行')
    expect(categoryNameProblem(' 节日 ', ['水果'])).toBeNull()
    expect(categoryNameProblem('水果', ['水果'])).toBe('已经有叫「水果」的分类了')
    expect(categoryNameProblem('节'.repeat(11), [])).toBe('分类名最多 10 个字，不能换行')
  })

  it('公告 200 字以内，可以换行', () => {
    expect(announcementProblem('店休一天\n照常营业')).toBeNull()
    expect(announcementProblem('')).toBeNull()
    expect(announcementProblem('长'.repeat(201))).toBe('公告最多 200 个字，现在 201 个')
    expect(announcementStatus(null).label).toBe('没有公告')
    expect(announcementStatus({ body: 'x', expiresOn: '2026-10-22', updatedAt: '', expired: false }).label).toBe(
      '首页显示中，显示到 2026-10-22',
    )
    expect(announcementStatus({ body: 'x', expiresOn: null, updatedAt: '', expired: false }).label).toBe(
      '首页显示中，不过期',
    )
    expect(announcementStatus({ body: 'x', expiresOn: '2026-10-01', updatedAt: '', expired: true }).color).toBe(
      'orange',
    )
  })

  it('上移下移只换相邻两个，到头不动', () => {
    expect(moveId(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c'])
    expect(moveId(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b'])
    expect(moveId(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c'])
    expect(moveId(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'b', 'c'])
  })

  it('上新还剩几天：第一次上架起 7 天，向上取整', () => {
    const first = '2026-10-20T02:00:00Z'
    expect(newDaysLeft(pattern({ isNew: true, firstPublishedAt: first }), new Date('2026-10-20T03:00:00Z'))).toBe(7)
    expect(newDaysLeft(pattern({ isNew: true, firstPublishedAt: first }), new Date('2026-10-26T03:00:00Z'))).toBe(1)
    expect(newDaysLeft(pattern({ isNew: false, firstPublishedAt: first }), new Date('2026-10-20T03:00:00Z'))).toBeNull()
  })

  it('分类名写明不分类和已停用；按分类数图纸', () => {
    expect(categoryLabel(categories, null)).toBe('不分类')
    expect(categoryLabel(categories, 'c1')).toBe('水果')
    expect(categoryLabel(categories, 'c2')).toBe('花草（已停用）')
    const counts = patternCounts([
      pattern({}),
      pattern({ id: 'p2', published: false }),
      pattern({ id: 'p3', categoryId: null }),
    ])
    expect(counts.get('c1')).toBe(2)
    expect(counts.has('c2')).toBe(false)
  })
})
