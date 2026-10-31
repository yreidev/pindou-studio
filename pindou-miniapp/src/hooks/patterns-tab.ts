import Taro, { useDidShow } from '@tarojs/taro'
import { useEffect } from 'react'
import { patternsTabText } from '../services/storefront'

/**
 * 按店里有没有上架的图纸改底部第二格的名字（「图纸」/「做图纸」，见 services/storefront.ts 的 patternsTabText）。
 * 首页（「今天来示例工坊拼什么？」那几张）和图纸页（图纸库）调，两边是后端同一个筛选；还没读到时传 null，不动
 * （保持 app.config.ts 的「做图纸」）。setTabBarItem 只能在底部栏的页面上调，所以每次显示时再设一遍。
 */
export function usePatternsTabText(hasPatterns: boolean | null) {
  useEffect(() => setPatternsTab(hasPatterns), [hasPatterns])
  useDidShow(() => setPatternsTab(hasPatterns))
}

function setPatternsTab(hasPatterns: boolean | null) {
  if (hasPatterns === null) return
  Taro.setTabBarItem({ index: 1, text: patternsTabText(hasPatterns) }).catch(() => {
    // 不在底部栏页面上（例如分享进来的页面）时会失败，下次回到底部栏页面再设
  })
}
