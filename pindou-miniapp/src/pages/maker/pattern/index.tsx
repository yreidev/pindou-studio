import { Canvas, Input, Text, View } from '@tarojs/components'
import Taro, { useDidHide, useDidShow, useRouter } from '@tarojs/taro'
import { useEffect, useRef, useState } from 'react'
import { Button } from '../../../components/button'
import { Screen, Skeleton, Status } from '../../../components/customer'
import { Sheet } from '../../../components/maker/sheets'
import { useCustomer } from '../../../hooks/customer'
import { usePublicQuery } from '../../../hooks/query'
import { beginLogin } from '../../../services/navigation'
import { beadApi } from '../../../services/maker/api'
import { Editor } from '../../../services/maker/edit'
import { cleanName } from '../../../services/maker/grid'
import { palette as paletteOf } from '../../../services/maker/palettes'
import { session } from '../../../services/maker/session'
import {
  deviceStorage,
  keepMine,
  loadLocal,
  pickCopy,
  saveLocal,
  sync,
  takeTheirs,
  type Draft,
  type SyncResult,
} from '../../../services/maker/store'
import { BeadTab } from './bead-tab'
import { EditTab } from './edit-tab'
import { ListTab } from './list-tab'
import './index.scss'

// 一张图纸：改图、用豆清单、边拼边看三个页签（画稿 MEdit、MList、MBead、MBeadRow）。名字在标题栏里，点了改名。
// 改图、边拼边看一屏放下、页面不滚（画布占掉剩下的高度）；清单是长列表，照常滚。
// 每改一步存在手机上；存进「我的图纸」以后停手 3 秒同步进账户（store.ts），别处改过时让顾客选用哪份。

type Tab = 'edit' | 'list' | 'bead'
export type SyncState = 'local' | 'saving' | 'saved' | 'later' | 'conflict' | 'full'

export default function MakerPattern() {
  const { params } = useRouter()
  const id = params.id || ''
  const auth = useCustomer()
  const store = usePublicQuery(['bead-settings'], beadApi.settings, { once: true }).data
  const [draft, setDraft] = useState<Draft>()
  const [problem, setProblem] = useState('')
  const [tab, setTab] = useState<Tab>(params.tab === 'bead' ? 'bead' : 'edit')
  const [syncState, setSyncState] = useState<SyncState>('local')
  const [syncMessage, setSyncMessage] = useState('')
  const [version, setVersion] = useState(0)
  const [renaming, setRenaming] = useState(false)
  const editor = useRef<Editor>()
  const saveTimer = useRef<ReturnType<typeof setTimeout>>()
  const syncTimer = useRef<ReturnType<typeof setTimeout>>()
  const syncing = useRef(false)

  const open = (d: Draft) => {
    editor.current = new Editor(d.grid, d.locked)
    setDraft(d)
    setSyncState(d.inAccount ? (d.dirty ? 'later' : 'saved') : 'local')
  }

  // 打开：刚生成的在内存里；否则先看手机上，账户里的再和账户对一下
  useEffect(() => {
    if (draft?.id === id) return
    if (session.draft?.id === id) {
      open(session.draft)
      session.draft = undefined
      return
    }
    const local = loadLocal(deviceStorage, id)
    if (local && !local.inAccount) return open(local)
    if (auth.status === 'loading') return
    if (auth.status !== 'authenticated') {
      if (local) return open(local)
      setProblem('登录后才能打开存在账户里的图纸')
      return
    }
    beadApi.get(id).then(
      (server) => {
        const picked = pickCopy(server, local)
        if (!picked) return setProblem('这张图纸读不出来')
        open(picked.draft)
        if (picked.conflict) setSyncState('conflict')
      },
      (error) => {
        if (local) open(local)
        else
          setProblem(
            (error as { status?: number })?.status === 404 ? '这张图纸已经删掉了' : '图纸暂时读不出来，请稍后再试',
          )
      },
    )
  }, [id, auth.status]) // eslint-disable-line react-hooks/exhaustive-deps

  const runSync = async () => {
    const d = draft
    if (!d || !d.inAccount || syncing.current || auth.status !== 'authenticated') return
    syncing.current = true
    setSyncState('saving')
    let result: SyncResult
    try {
      result = await sync(deviceStorage, d)
    } finally {
      syncing.current = false
    }
    if (result.status === 'saved') setSyncState(d.dirty ? 'later' : 'saved')
    else if (result.status === 'later' || result.status === 'invalid') {
      setSyncState('later')
      setSyncMessage(result.status === 'invalid' ? result.message : '')
    } else setSyncState(result.status)
    if (result.status === 'saved' && d.dirty) schedule()
  }
  const schedule = () => {
    clearTimeout(syncTimer.current)
    syncTimer.current = setTimeout(() => void runSync(), 3000)
  }

  /** 改了一步（格子、拼完的格子、名字）：存手机，存进账户的停手 3 秒后同步。 */
  const changed = () => {
    const d = draft
    if (!d) return
    d.updatedAt = Date.now()
    d.dirty = true
    setVersion((v) => v + 1)
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      try {
        saveLocal(deviceStorage, d)
      } catch {
        void Taro.showToast({ title: '手机存储满了，最近的改动没存上', icon: 'none' })
      }
    }, 400)
    if (d.inAccount) {
      if (syncState !== 'conflict' && syncState !== 'full') setSyncState('later')
      schedule()
    }
  }

  const flush = () => {
    const d = draft
    if (!d) return
    clearTimeout(saveTimer.current)
    try {
      saveLocal(deviceStorage, d)
    } catch {
      /* 存不进也不拦着离开 */
    }
    if (d.inAccount && d.dirty && syncState !== 'conflict') void runSync()
  }
  useDidHide(flush)
  useDidShow(() => {
    if (draft?.inAccount && draft.dirty && syncState === 'later') void runSync()
  })
  useEffect(
    () => () => {
      clearTimeout(saveTimer.current)
      clearTimeout(syncTimer.current)
    },
    [],
  )

  /** 存到我的图纸：要登录；存满 30 张时说清楚。 */
  const saveToAccount = async () => {
    const d = draft
    if (!d) return
    if (auth.status !== 'authenticated') {
      flush()
      void beginLogin(`/pages/maker/pattern/index?id=${encodeURIComponent(d.id)}`)
      return
    }
    d.inAccount = true
    d.dirty = true
    setSyncState('saving')
    await runSync()
  }

  const resolve = async (mine: boolean) => {
    const d = draft
    if (!d) return
    try {
      if (mine) {
        setSyncState('saving')
        const result = await keepMine(deviceStorage, d)
        setSyncState(
          result.status === 'saved'
            ? 'saved'
            : result.status === 'conflict'
              ? 'conflict'
              : result.status === 'full'
                ? 'full'
                : 'later',
        )
      } else open(await takeTheirs(deviceStorage, d))
    } catch {
      void Taro.showToast({ title: '网络连接失败，请稍后再试', icon: 'none' })
    }
  }

  if (problem)
    return (
      <Screen title="做图纸" back>
        <Status
          title={problem}
          action={auth.status !== 'authenticated' ? '登录' : undefined}
          onAction={() => void beginLogin(`/pages/maker/pattern/index?id=${encodeURIComponent(id)}`)}
        />
      </Screen>
    )
  if (!draft || !editor.current)
    return (
      <Screen title="做图纸" back>
        <Skeleton rows={2} />
      </Screen>
    )
  const pal = paletteOf(draft.grid.palette)
  if (!pal)
    return (
      <Screen title="做图纸" back>
        <Status title="这张图纸用的色卡没有了" message="先把小程序更新到最新再打开。" />
      </Screen>
    )

  const syncLine =
    syncState === 'local'
      ? '每一步都自动存在手机上'
      : syncState === 'saving'
        ? '正在存进账户…'
        : syncState === 'saved'
          ? '已存进我的图纸'
          : syncState === 'full'
            ? '我的图纸已经存满 30 张，删掉几张再存'
            : syncState === 'conflict'
              ? '别处改过这张图纸'
              : syncMessage || '先存在手机上，有网时自动存进账户'

  // 别处改过的横幅出来、收起时画布高度变了，要重新量
  const layout = syncState === 'conflict' ? 'banner' : ''
  return (
    <Screen
      title={draft.name}
      onTitle={() => setRenaming(true)}
      back
      dark={tab === 'bead'}
      className={`maker-screen ${tab === 'list' ? '' : 'maker-screen-fit'} ${tab === 'bead' ? 'maker-screen-dark' : ''}`}
    >
      <View className="maker-tabs">
        {(['edit', 'list', 'bead'] as Tab[]).map((t) => (
          <Button key={t} className={`maker-tab ${tab === t ? 'maker-tab-selected' : ''}`} onClick={() => setTab(t)}>
            {t === 'edit' ? '改图' : t === 'list' ? '用豆清单' : '边拼边看'}
          </Button>
        ))}
      </View>
      {syncState === 'conflict' && (
        <View className="maker-banner">
          <Text className="maker-banner-text">别处（另一台手机）也改过这张图纸，用哪一份？</Text>
          <View className="maker-row-actions">
            <Button className="maker-action" onClick={() => void resolve(true)}>
              用这台手机上的
            </Button>
            <Button className="maker-action" onClick={() => void resolve(false)}>
              用账户里的
            </Button>
          </View>
        </View>
      )}
      {tab === 'edit' && (
        <EditTab
          draft={draft}
          editor={editor.current}
          palette={pal}
          store={store}
          version={version}
          onChange={changed}
          syncLine={syncLine}
          inAccount={draft.inAccount}
          onSave={() => void saveToAccount()}
          layout={layout}
        />
      )}
      {tab === 'list' && (
        <ListTab
          draft={draft}
          editor={editor.current}
          palette={pal}
          store={store}
          version={version}
          onChange={changed}
        />
      )}
      {tab === 'bead' && (
        <BeadTab
          draft={draft}
          palette={pal}
          store={store}
          version={version}
          onChange={changed}
          inAccount={draft.inAccount}
          layout={layout}
        />
      )}
      <Canvas id="maker-export" type="2d" className="maker-export-canvas" />
      {renaming && (
        <RenameSheet
          name={draft.name}
          onClose={() => setRenaming(false)}
          onSave={(name) => {
            draft.name = name
            setRenaming(false)
            changed()
          }}
        />
      )}
    </Screen>
  )
}

function RenameSheet({ name, onClose, onSave }: { name: string; onClose: () => void; onSave: (name: string) => void }) {
  const [value, setValue] = useState(name)
  const clean = cleanName(value)
  return (
    <Sheet
      title="改名"
      onClose={onClose}
      footer={
        <Button className="button button-primary" disabled={!clean} onClick={() => clean && onSave(clean)}>
          保存
        </Button>
      }
    >
      <Input className="input" value={value} maxlength={20} focus onInput={(e) => setValue(e.detail.value)} />
      <Text className="maker-note">1～20 个字</Text>
    </Sheet>
  )
}
