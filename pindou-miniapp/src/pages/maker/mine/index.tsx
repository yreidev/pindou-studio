import { Image, Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { useMemo, useState } from 'react'
import { Button } from '../../../components/button'
import { RefreshNotice, Screen, SectionEmpty, Skeleton } from '../../../components/customer'
import { Sheet } from '../../../components/maker/sheets'
import { useCustomer } from '../../../hooks/customer'
import { useCustomerQuery, usePublicQuery } from '../../../hooks/query'
import { beginLogin, navigateApp } from '../../../services/navigation'
import { beadApi, type BeadPatternSummary } from '../../../services/maker/api'
import { progress } from '../../../services/maker/boards'
import { DeviceError, fileImportDeclared, pickText, shareText } from '../../../services/maker/device'
import { fromCsv, fromFile, toCsv, toFile } from '../../../services/maker/file'
import { makerPages, startFromPhoto } from '../../../services/maker/flow'
import { beadCounts, blankDone, blankGrid, cloneGrid, newId, type Grid } from '../../../services/maker/grid'
import { rememberedPalette, session } from '../../../services/maker/session'
import {
  deviceStorage,
  fromServer,
  localDrafts,
  removeLocal,
  saveLocal,
  type Draft,
} from '../../../services/maker/store'
import { previewOf, thumbSrc } from '../../../services/maker/thumbs'
import './index.scss'

// 我的图纸（画稿 MMine）：四个新建入口（用照片做、空白开始画、导入像素画或截图、导入图纸文件；
// 最后一个要隐私指引里有「选中的文件」才显示，见 fileImportDeclared，2026-10-27 起打开），
// 下面是账户里的图纸（最多 30 张，只有自己看得到）和只在这台手机上、还没存进账户的。
// 每张的「⋮」：改名在图纸里改；这里是复制一份、导出图纸文件、导出表格、删除。

type Row = {
  id: string
  name: string
  meta: string
  progress: string
  when: string
  thumb: string
  local: boolean
  summary?: BeadPatternSummary
}

function when(ms: number) {
  const d = new Date(ms)
  const today = new Date()
  if (d.toDateString() === today.toDateString())
    return `今天 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

const localThumb = (d: Draft) =>
  thumbSrc({ id: d.id, revision: d.updatedAt, palette: d.grid.palette, colors: d.grid.colors, ...previewOf(d.grid) })

export default function MakerMine() {
  const auth = useCustomer()
  const list = useCustomerQuery(['bead-patterns'], beadApi.list)
  const store = usePublicQuery(['bead-settings'], beadApi.settings, { once: true }).data
  const [locals, setLocals] = useState(() => localDrafts(deviceStorage))
  const [menu, setMenu] = useState<Row>()
  useDidShow(() => setLocals(localDrafts(deviceStorage)))

  const signedIn = auth.status === 'authenticated' && !!list.data
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    const inAccount = new Set(signedIn ? list.data!.patterns.map((p) => p.id) : [])
    for (const d of locals) {
      // 账户里有的显示账户那一行（手机上的副本只是缓存）；没登录、或点了「存到我的图纸」还没存上的，列手机上这一份
      if (inAccount.has(d.id)) continue
      const c = beadCounts(d.grid, d.done)
      out.push({
        id: d.id,
        name: d.name,
        meta: `${d.grid.width}×${d.grid.height} 格 · ${c.beads} 颗`,
        progress: c.done ? `拼到 ${progress(c.beads, c.done)}%` : '',
        when: `${when(d.updatedAt)} · ${!d.inAccount ? '只在这台手机上' : signedIn ? '还没存进账户，打开后接着存' : '登录后接着同步'}`,
        thumb: localThumb(d),
        local: true,
      })
    }
    for (const p of list.data?.patterns ?? [])
      out.push({
        id: p.id,
        name: p.name,
        meta: `${p.width}×${p.height} 格 · ${p.beads} 颗`,
        progress: p.doneBeads ? `拼到 ${progress(p.beads, p.doneBeads)}%` : '',
        when: when(Date.parse(p.updatedAt)),
        thumb: thumbSrc(p),
        local: false,
        summary: p,
      })
    return out
  }, [locals, list.data, signedIn])

  const openNew = (grid: Grid, name: string, done?: Uint8Array) => {
    const draft: Draft = {
      id: newId(),
      name,
      grid,
      done: done ?? blankDone(grid),
      locked: new Uint8Array(grid.cells.length),
      revision: 0,
      inAccount: false,
      dirty: true,
      updatedAt: Date.now(),
    }
    try {
      saveLocal(deviceStorage, draft)
    } catch {
      /* 手机存储满了也先打开 */
    }
    session.draft = draft
    void navigateApp(makerPages.pattern(draft.id))
  }

  const blank = async () => {
    const sizes = ['29×29 格（小板一块）', '52×52 格（大板一块）', '58×58 格（小板 2×2）', '104×104 格（大板 2×2）']
    try {
      const { tapIndex } = await Taro.showActionSheet({ itemList: sizes })
      const side = [29, 52, 58, 104][tapIndex]
      openNew(blankGrid(side, side, rememberedPalette(store?.palette)), '空白图纸')
    } catch {
      /* 取消 */
    }
  }

  const importFile = async () => {
    let picked: { name: string; text: string } | undefined
    try {
      picked = await pickText(['json', 'csv', 'txt'])
    } catch (error) {
      void Taro.showToast({ title: error instanceof DeviceError ? error.message : '文件读不出来', icon: 'none' })
      return
    }
    if (!picked) return
    const base = picked.name.replace(/\.[^.]+$/, '').slice(0, 20) || '导入的图纸'
    if (/\.csv$/i.test(picked.name)) {
      const r = fromCsv(picked.text)
      if (!r.ok) return void Taro.showModal({ title: '导入不了', content: r.error, showCancel: false })
      openNew(r.grid, base)
      return
    }
    const r = fromFile(picked.text)
    if (!r.ok) return void Taro.showModal({ title: '导入不了', content: r.error, showCancel: false })
    openNew(r.pattern.grid, r.pattern.name, r.pattern.done)
  }

  /** 拿到一张的完整内容（复制、导出用）。 */
  const full = async (row: Row): Promise<Draft | undefined> => {
    const local = locals.find((d) => d.id === row.id)
    if (row.local && local) return local
    try {
      return fromServer(await beadApi.get(row.id)) ?? undefined
    } catch {
      void Taro.showToast({ title: '图纸暂时读不出来', icon: 'none' })
      return undefined
    }
  }

  const act = async (row: Row, action: 'copy' | 'file' | 'csv' | 'delete') => {
    setMenu(undefined)
    if (action === 'delete') {
      const ok = (
        await Taro.showModal({
          title: `删掉「${row.name}」？`,
          content: '删掉以后找不回来。',
          confirmText: '删掉',
          confirmColor: '#a82929',
        })
      ).confirm
      if (!ok) return
      try {
        if (!row.local) await beadApi.remove(row.id)
        removeLocal(deviceStorage, row.id)
        setLocals(localDrafts(deviceStorage))
        void list.refresh()
      } catch {
        void Taro.showToast({ title: '没删掉，请稍后再试', icon: 'none' })
      }
      return
    }
    const d = await full(row)
    if (!d) return
    try {
      if (action === 'copy') openNew(cloneGrid(d.grid), `${d.name.slice(0, 17)} 副本`, d.done.slice())
      else if (action === 'file')
        await shareText(`${d.name}.json`, toFile({ name: d.name, grid: d.grid, done: d.done }))
      else await shareText(`${d.name}.csv`, toCsv(d.grid))
    } catch (error) {
      void Taro.showToast({ title: error instanceof DeviceError ? error.message : '没发出去', icon: 'none' })
    }
  }

  return (
    <Screen title="我的图纸" back className="maker-screen">
      <View className="maker-mine-head">
        <Text className="maker-strong">{list.data ? `存了 ${list.data.patterns.length} 张` : '我的图纸'}</Text>
        <Text className="maker-note">最多存 {list.data?.limit ?? 30} 张 · 只有你自己看得到</Text>
      </View>
      <View className="maker-entries">
        <Button className="maker-entry maker-entry-primary" onClick={() => void startFromPhoto()}>
          用照片做
        </Button>
        <Button className="maker-entry" onClick={() => void blank()}>
          空白开始画
        </Button>
        <Button className="maker-entry" onClick={() => void navigateApp(makerPages.import)}>
          导入像素画、截图
        </Button>
        {fileImportDeclared && (
          <Button className="maker-entry" onClick={() => void importFile()}>
            导入图纸文件
          </Button>
        )}
      </View>
      {!!list.error && !!list.data && <RefreshNotice retry={() => void list.refresh()} />}
      {list.loading && !rows.length ? (
        <Skeleton rows={2} />
      ) : rows.length === 0 ? (
        <SectionEmpty title="还没有图纸" message="用照片做一张，或者空白开始画。" />
      ) : (
        <View className="maker-mine-list">
          {rows.map((row) => (
            <View key={row.id} className="maker-mine-row enter">
              <Button
                className="maker-mine-open"
                ariaLabel={`${row.name}，打开`}
                onClick={() => void navigateApp(makerPages.pattern(row.id))}
              >
                {row.thumb ? (
                  <Image className="maker-mine-thumb" src={row.thumb} mode="aspectFit" />
                ) : (
                  <View className="maker-mine-thumb" />
                )}
                <View className="maker-mine-copy">
                  <Text className="maker-mine-name">{row.name}</Text>
                  <Text className="maker-note">{row.when}</Text>
                  <Text className="maker-note">
                    {row.meta}
                    {row.progress ? ` · ${row.progress}` : ''}
                  </Text>
                </View>
              </Button>
              <Button className="maker-mine-more" ariaLabel={`${row.name}，更多操作`} onClick={() => setMenu(row)}>
                ⋮
              </Button>
            </View>
          ))}
        </View>
      )}
      {auth.status !== 'authenticated' && (
        <View className="maker-banner">
          <Text className="maker-banner-text">没登录也能做、能存相册；要存在这里、换手机接着拼，先登录。</Text>
          <Button className="maker-action maker-action-primary" onClick={() => void beginLogin(makerPages.mine)}>
            登录
          </Button>
        </View>
      )}
      {menu && (
        <Sheet title={menu.name} onClose={() => setMenu(undefined)}>
          <View className="maker-menu">
            <Button className="maker-menu-item" onClick={() => void act(menu, 'copy')}>
              复制一份
            </Button>
            <Button className="maker-menu-item" onClick={() => void act(menu, 'file')}>
              导出图纸文件（发到聊天）
            </Button>
            <Button className="maker-menu-item" onClick={() => void act(menu, 'csv')}>
              导出表格（发到聊天）
            </Button>
            <Button className="maker-menu-item maker-menu-danger" onClick={() => void act(menu, 'delete')}>
              删除
            </Button>
          </View>
          <Text className="maker-note">
            {fileImportDeclared
              ? '改名在图纸里点名字。图纸文件发给朋友、换手机后导回来能接着改。'
              : '改名在图纸里点名字。图纸文件可以发给朋友，或者发给自己留一份。'}
          </Text>
        </Sheet>
      )}
    </Screen>
  )
}
