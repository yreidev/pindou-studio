import { Image, Text, View } from '@tarojs/components'
import Taro, { useRouter, useShareAppMessage, useShareTimeline } from '@tarojs/taro'
import { Button } from '../../../components/button'
import { Failure, RefreshNotice, Screen, Skeleton, Status } from '../../../components/customer'
import { useCustomer } from '../../../hooks/customer'
import { usePublicQuery } from '../../../hooks/query'
import { beginLogin, navigateApp } from '../../../services/navigation'
import { homeShare, homeTimeline, patternShare, patternTimeline } from '../../../services/share'
import { categoryName, imageUrl, storefront } from '../../../services/storefront'
import './index.scss'

// 一张图纸：大图（点开放大，长按存到手机）、名字、分类、本周上新，底下「预约来拼这张」。
// 图纸库和「图纸」页同一份查询，从列表点进来不用再读一次；后端不单给一张，找不到就是下架或删了。
// 转发、朋友圈的卡片图用这张图纸的缩略图；图纸还没读到或已下架时退回首页的卡片。

const reserve = '/pages/customer/reservations/index'

export default function PatternDetail() {
  const { params } = useRouter()
  const auth = useCustomer()
  const library = usePublicQuery(['patterns'], storefront.patterns)
  const data = library.data
  const pattern = data?.patterns.find((item) => item.id === params.id)
  const toolOnly = data?.patterns.length === 0
  const shared = pattern && { id: pattern.id, name: pattern.name, thumbnailUrl: imageUrl(pattern.thumbnailPath) }
  useShareAppMessage(() => (shared ? patternShare(shared) : homeShare()))
  useShareTimeline(() => (shared ? patternTimeline(shared) : homeTimeline()))
  const preview = (url: string) => {
    void Taro.previewImage({ urls: [url], current: url }).catch(() => undefined)
  }
  return (
    <Screen title="图纸" back className="pattern-screen">
      {library.loading ? (
        <Skeleton rows={2} />
      ) : !data ? (
        <Failure error={library.error} retry={library.refresh} />
      ) : !pattern ? (
        <Status
          kind="empty"
          title="这张图纸下架了"
          // 店里一张上架的都没有时，小程序底部那格叫「做图纸」（见 pages/patterns/index.tsx）
          message={toolOnly ? '店里的图纸暂时都下架了，可以先用照片自己做一张。' : '去「图纸」看看别的吧。'}
          action={toolOnly ? '去做图纸' : '看全部图纸'}
          onAction={() => {
            void navigateApp('/pages/patterns/index')
          }}
        />
      ) : (
        <View className="pattern-content">
          {!!library.error && <RefreshNotice retry={library.refresh} />}
          <Button
            className="pattern-media"
            ariaLabel={`${pattern.name}，点开放大`}
            onClick={() => preview(imageUrl(pattern.imagePath))}
          >
            <Image
              className="pattern-image"
              src={imageUrl(pattern.imagePath)}
              mode="widthFix"
              style={{ aspectRatio: `${pattern.width} / ${pattern.height}` }}
            />
          </Button>
          <Text className="muted pattern-hint">点图纸放大，长按可以存到手机</Text>
          <View className="pattern-title">
            <Text className="pattern-name">{pattern.name}</Text>
            {pattern.isNew && <Text className="pattern-tag pattern-tag-new">本周上新</Text>}
            {!!categoryName(data, pattern) && <Text className="pattern-tag">{categoryName(data, pattern)}</Text>}
          </View>
          <Button
            className="button button-primary pattern-reserve"
            onClick={() => {
              if (auth.status === 'authenticated') void navigateApp(reserve)
              else void beginLogin(reserve)
            }}
          >
            预约来拼这张
          </Button>
        </View>
      )}
    </Screen>
  )
}
