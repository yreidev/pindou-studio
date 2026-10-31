import { useState } from 'react'
import { Image, Text, View } from '@tarojs/components'
import { useDidShow, useRouter, useShareAppMessage, useShareTimeline } from '@tarojs/taro'
import { Button } from '../../components/button'
import { Failure, RefreshNotice, Screen, SectionEmpty, Skeleton } from '../../components/customer'
import { useOrdersTabText } from '../../hooks/billing'
import { useCustomer } from '../../hooks/customer'
import { usePatternsTabText } from '../../hooks/patterns-tab'
import { useCustomerQuery, usePublicQuery } from '../../hooks/query'
import { patternColumn } from '../../brand'
import { navigateApp } from '../../services/navigation'
import { beadApi } from '../../services/maker/api'
import { myPatterns } from '../../services/maker/mine'
import { deviceStorage, localIndex } from '../../services/maker/store'
import { patternsShare, patternsTimeline } from '../../services/share'
import { filterPatterns, imageUrl, patternFilters, storefront } from '../../services/storefront'
import './index.scss'

// 底部「图纸」：顶上是做图纸的两个入口（「用照片做图纸」「我的图纸」，docs/plan-bead-maker.md），
// 下面是员工在网页后台「首页内容」上传、上架的图纸，按员工排的顺序。没登录也能看。
// 第一次上架起 7 天标「本周上新」（后端算好 isNew）。点开进详情看大图。
// 转发带着正在看的分类（?category=），朋友打开时站在同一个分类。
// 这一页在主包：只引做图纸的接口和本机索引（几 KB），色卡和算法在 pages/maker 分包里。
//
// ★ 店里一张上架的图纸都没有时（2026-10-28 业主定，docs/plan-home-and-patterns.md）：这一页和底部那格叫「做图纸」，
//   只放做图纸的两个入口，不摆「今天来示例工坊拼什么？」和「图纸还在准备中」。0.0.37 提审因【图纸】页「无具体运营内容」被驳回。
//   业主在网页后台上架第一张图纸，顾客下次打开就显示店里的图纸，不用发版。还没读到时按没有算，读到了再换。

export default function Patterns() {
  useOrdersTabText()
  const library = usePublicQuery(['patterns'], storefront.patterns)
  const { params } = useRouter()
  const [chosen, setChosen] = useState(() => params.category || 'all')
  const data = library.data
  const hasPatterns = !!data && data.patterns.length > 0
  usePatternsTabText(data ? hasPatterns : null)
  const filters = data ? patternFilters(data) : []
  // 选着的分类刚被停用、或里面的图纸都下架了：回到「全部」
  const active = filters.some((filter) => filter.key === chosen) ? chosen : 'all'
  const patterns = data ? filterPatterns(data.patterns, active) : []
  useShareAppMessage(() => patternsShare(active, hasPatterns))
  useShareTimeline(() => patternsTimeline(active, hasPatterns))
  return (
    <Screen title={hasPatterns ? '图纸' : '做图纸'} className="patterns-screen">
      <MakerEntries />
      {hasPatterns ? (
        <>
          <View className="patterns-intro">
            <Text className="patterns-heading">{patternColumn}</Text>
            <Text className="muted">店里挑的图纸，不定期上新。点开看大图，到店照着拼。</Text>
          </View>
          {library.loading ? (
            <Skeleton rows={2} />
          ) : !data ? (
            <Failure error={library.error} retry={library.refresh} />
          ) : (
            <>
              {!!library.error && <RefreshNotice retry={library.refresh} />}
              {filters.length > 1 && (
                <View className="patterns-filters">
                  {filters.map((filter) => (
                    <Button
                      key={filter.key}
                      className={`patterns-filter ${active === filter.key ? 'patterns-filter-selected' : ''}`}
                      onClick={() => setChosen(filter.key)}
                    >
                      {filter.label}
                    </Button>
                  ))}
                </View>
              )}
              {patterns.length === 0 ? (
                <SectionEmpty title="图纸还在准备中" message="店里上新后会出现在这里。" />
              ) : (
                <View className="patterns-grid">
                  {patterns.map((pattern) => (
                    <Button
                      key={pattern.id}
                      className="patterns-card enter"
                      ariaLabel={`${pattern.name}${pattern.isNew ? '，本周上新' : ''}，看大图`}
                      onClick={() => {
                        void navigateApp(`/pages/customer/pattern/index?id=${encodeURIComponent(pattern.id)}`)
                      }}
                    >
                      <View className="patterns-media">
                        <Image
                          className="patterns-image"
                          src={imageUrl(pattern.thumbnailPath)}
                          mode="aspectFill"
                          lazyLoad
                        />
                      </View>
                      <View className="patterns-caption">
                        <Text className="patterns-name">{pattern.name}</Text>
                        {pattern.isNew && <Text className="patterns-new">本周上新</Text>}
                      </View>
                    </Button>
                  ))}
                </View>
              )}
            </>
          )}
        </>
      ) : (
        // 不知道店里有没有图纸（没读到）时只给重试，不说「还在准备中」
        !library.loading && !data && <Failure error={library.error} retry={library.refresh} />
      )}
    </Screen>
  )
}

/** 「用照片做图纸」「我的图纸」：几张、最近一张拼到多少。 */
function MakerEntries() {
  const auth = useCustomer()
  const list = useCustomerQuery(['bead-patterns'], beadApi.list)
  const [local, setLocal] = useState(() => localIndex(deviceStorage))
  useDidShow(() => setLocal(localIndex(deviceStorage)))
  const mine = myPatterns(auth.status === 'authenticated' ? list.data : undefined, local)
  const summary = mine.latest
    ? `${mine.count} 张 · ${mine.latest.name}${mine.latest.doneBeads ? `拼到 ${mine.latestProgress}%` : ''}`
    : '做好的图纸存在这里'
  return (
    <View className="patterns-maker">
      <Button className="patterns-maker-main" onClick={() => void navigateApp('/pages/maker/photo/index?pick=1')}>
        <Text className="patterns-maker-title">用照片做图纸</Text>
        <Text className="patterns-maker-note">宠物、自拍、喜欢的图，转成拼豆图纸，还能自己改</Text>
      </Button>
      <Button
        className="patterns-maker-mine"
        ariaLabel={`我的图纸，${summary}`}
        onClick={() => void navigateApp('/pages/maker/mine/index')}
      >
        <Text className="patterns-maker-title">我的图纸</Text>
        {mine.latest ? (
          <>
            <Text className="patterns-maker-note">{mine.count} 张</Text>
            {/* 最近一张的名字单独一行，长了省略：放在「几张」后面一起折行时，会从「10-25」中间断开 */}
            <View className="patterns-maker-latest">
              <Text className="patterns-maker-latest-name">{mine.latest.name}</Text>
              {mine.latest.doneBeads ? (
                <Text className="patterns-maker-latest-done">{mine.latestProgress}%</Text>
              ) : null}
            </View>
          </>
        ) : (
          <Text className="patterns-maker-note">{summary}</Text>
        )}
      </Button>
    </View>
  )
}
