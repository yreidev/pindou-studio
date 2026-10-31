import { Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { Button } from '../button'
import { contactLine, dialNumber, type StoreContact } from '../../services/reservations'
import type { Storefront } from '../../services/storefront'

/**
 * 门店联系方式：电话点一下拨号，微信号点一下复制。都没填时不画——前面的话里已经写了「请联系门店」。
 * 预约超限、爽约暂停的说明和包间说明后面都接它；样式在 styles/_store-contact.scss，用到的页面各自引入。
 *
 * ★ 按函数调用（storeContactActions(contact)），不写成组件：页面树里直接就是这几个按钮，单测照样找得到。
 */
export function storeContactActions(contact: StoreContact) {
  if (!contactLine(contact)) return null
  return (
    <View className="store-contact">
      {!!contact.phone && (
        <Button
          className="store-contact-item"
          ariaLabel={`拨打门店电话 ${contact.phone}`}
          onClick={() => void Taro.makePhoneCall({ phoneNumber: dialNumber(contact.phone) }).catch(() => undefined)}
        >
          <Text className="store-contact-label">电话</Text>
          <Text className="store-contact-value">{contact.phone}</Text>
        </Button>
      )}
      {!!contact.wechat && (
        <Button
          className="store-contact-item"
          ariaLabel={`复制门店微信号 ${contact.wechat}`}
          onClick={() =>
            void Taro.setClipboardData({ data: contact.wechat })
              .then(() => Taro.showToast({ title: '微信号已复制', icon: 'none' }))
              .catch(() => undefined)
          }
        >
          <Text className="store-contact-label">微信号</Text>
          <Text className="store-contact-value">{contact.wechat}</Text>
          <Text className="store-contact-hint">复制</Text>
        </Button>
      )}
    </View>
  )
}

/** 首页那份门店信息（带地址和经纬度）。 */
type StoreLocation = Pick<Storefront['contact'], 'phone' | 'wechat' | 'address' | 'latitude' | 'longitude'>

/**
 * 地图上标的店名：和腾讯地图上的门店标注同名（老板在微信里发位置用的就是那条），顾客两边对照不犯糊涂。
 * 只给地图用、不用品牌字体，所以不放 brand.ts。
 */
const mapStoreName = 'Example示例工坊·拼豆·手作研究室'

/** 导航到门店：打开微信的地图。没填经纬度时什么都不做。 */
export function openStoreMap(contact: StoreLocation) {
  if (contact.latitude === null || contact.longitude === null) return
  void Taro.openLocation({
    latitude: contact.latitude,
    longitude: contact.longitude,
    name: mapStoreName,
    address: contact.address,
    scale: 17,
  }).catch(() => undefined)
}

/** 「我的 › 联系门店」：电话、微信号、导航里填了的，从底部列出来选一个。 */
export function chooseStoreContact(contact: StoreLocation) {
  const items: { label: string; run: () => Promise<unknown> | void }[] = [
    ...(contact.phone
      ? [
          {
            label: `拨打电话 ${contact.phone}`,
            run: () => Taro.makePhoneCall({ phoneNumber: dialNumber(contact.phone) }),
          },
        ]
      : []),
    ...(contact.wechat
      ? [
          {
            label: `复制微信号 ${contact.wechat}`,
            run: () =>
              Taro.setClipboardData({ data: contact.wechat }).then(() =>
                Taro.showToast({ title: '微信号已复制', icon: 'none' }),
              ),
          },
        ]
      : []),
    ...(contact.latitude !== null && contact.longitude !== null
      ? [{ label: '导航到门店', run: () => openStoreMap(contact) }]
      : []),
  ]
  if (!items.length) return
  void Taro.showActionSheet({ itemList: items.map((item) => item.label) })
    .then(async (result) => {
      await items[result.tapIndex]?.run()
    })
    .catch(() => undefined)
}
