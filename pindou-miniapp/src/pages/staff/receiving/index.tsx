import { Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useEffect, useRef, useState } from 'react'
import { Button } from '../../../components/button'
import { ActionButton, Field, StaffScreen, Stepper, useStaffEvents, useStaffQuery } from '../../../components/staff'
import { useCustomer } from '../../../hooks/customer'
import { useLeaveGuard } from '../../../hooks/leave-guard'
import { useRefreshAll } from '../../../hooks/query'
import { money } from '../../../services/format'
import { catalogLabel, StaffError, staffMessage, type CatalogItem } from '../../../services/staff'
import {
  addProduct,
  lastUnitCost,
  receiptBody,
  receiptTotals,
  receiving,
  rowErrors,
  scanProduct,
  searchCatalog,
  unboundBarcodeMessage,
  type ReceiptRow,
} from '../../../services/receiving'
import './index.scss'

/**
 * 收货入库（2026-10-06 业主改定）：货到时人常不在电脑旁，手机上扫条码或按名称搜，录成一张入库单提交。
 * 店员、店长、老板都能用；扫到没登记的条码时店长、老板可以当场绑定到已有商品，店员请他们来绑。
 * 新建商品、改商品资料、盘点、库存流水仍在电脑后台。
 *
 * ★ 当前库存、上次进价、最近的供应商都来自接口，本机不记；入库成功后整页重读，库存以接口为准。
 * ★ 提交带幂等键：结果未知时再点「确认入库」照原样重发同一张单；改过内容再点，先确认上一张到底入没入，
 *   入了就提示「上次已生效」、不再提交这一张（services/staff.ts，和其他写操作一样）。
 */
export default function StaffReceiving() {
  const auth = useCustomer()
  const roles = auth.account?.roles || []
  const live = useStaffEvents()
  const data = useStaffQuery(
    ['stock-receipts', 'receiving'],
    () => Promise.all([receiving.catalog(), receiving.stock(), receiving.prefill()]),
    { refetchInterval: live.refetchInterval },
  )
  const catalog = data.data?.[0] || []
  const stock = data.data?.[1] || []
  const prefill = data.data?.[2] || null
  const refreshAll = useRefreshAll()

  const [supplier, setSupplier] = useState('')
  // 员工自己改过供应商（含清空）就不再拿最近一次的覆盖
  const supplierTouched = useRef(false)
  const [note, setNote] = useState('')
  const [rows, setRows] = useState<ReceiptRow[]>([])
  const [keyword, setKeyword] = useState('')
  // 扫到没登记的条码：店长、老板在这里选一件已有商品绑定
  const [unknown, setUnknown] = useState<{ barcode: string; canBind: boolean } | null>(null)
  const [bindKeyword, setBindKeyword] = useState('')
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const [validate, setValidate] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const lastSupplier = prefill?.supplierName || ''
  useEffect(() => {
    if (!supplierTouched.current && lastSupplier) setSupplier((value) => value || lastSupplier)
  }, [lastSupplier])
  useLeaveGuard(rows.length > 0 || !!note.trim(), busy)

  const run = async (work: () => Promise<void>) => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await work()
    } catch (e) {
      setError(staffMessage(e))
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  const add = (item: CatalogItem) => {
    const next = addProduct(rows, item.id, prefill)
    setRows(next.rows)
    setUnknown(null)
    void Taro.showToast({
      title: next.merged ? `${catalogLabel(item)} 数量 +1` : `已加入 ${catalogLabel(item)}`,
      icon: 'none',
    })
  }

  const scan = () =>
    run(async () => {
      const outcome = await scanProduct(roles)
      if (outcome.kind === 'cancelled') return
      if (outcome.kind === 'error') throw new Error(outcome.message)
      if (outcome.kind === 'found') return add(outcome.item)
      setBindKeyword('')
      setUnknown({ barcode: outcome.barcode, canBind: outcome.canBind })
    })

  const bind = (item: CatalogItem) =>
    run(async () => {
      if (!unknown) return
      if (item.barcode) {
        const replace = (
          await Taro.showModal({
            title: '换成新条码？',
            content: `「${catalogLabel(item)}」已登记条码 ${item.barcode}，换成 ${unknown.barcode} 后，扫旧条码就找不到这件商品了。`,
            confirmText: '换新条码',
            cancelText: '再看看',
          })
        ).confirm
        if (!replace) return
      }
      const bound = await receiving.bindBarcode(item.id, unknown.barcode)
      add(bound)
      setNotice(`条码 ${unknown.barcode} 已登记到「${catalogLabel(bound)}」，以后扫它就能直接加入。`)
      void refreshAll()
    })

  const submit = () => {
    let body: ReturnType<typeof receiptBody>
    try {
      body = receiptBody(supplier, note, rows, catalog)
    } catch (e) {
      setValidate(true)
      setError(staffMessage(e))
      return
    }
    void run(async () => {
      try {
        await receiving.submit(body)
      } catch (e) {
        // 上一次没收到结果的那张单其实已经入库了，这一张没有提交：留着内容让人核对
        if (e instanceof StaffError && e.code === 'previous_applied') {
          setNotice(e.message)
          void refreshAll()
          return
        }
        throw e
      }
      setRows([])
      setNote('')
      setKeyword('')
      setValidate(false)
      void Taro.showToast({ title: '已入库', icon: 'success' })
      void refreshAll()
    })
  }

  const itemOf = (productId: string) => catalog.find((item) => item.id === productId)
  const labelOf = (productId: string) => {
    const item = itemOf(productId)
    return item ? catalogLabel(item) : `未命名商品 · ${productId.slice(0, 8)}`
  }
  const stockOf = (productId: string) => stock.find((entry) => entry.productId === productId)?.quantity ?? 0
  const update = (index: number, field: 'quantity' | 'costYuan', value: string) =>
    setRows((previous) => previous.map((row, i) => (i === index ? { ...row, [field]: value } : row)))
  const matches = searchCatalog(catalog, keyword)
  // 绑定只给有名称的商品：没有名称的历史占位商品要先在电脑后台补资料
  const bindMatches = searchCatalog(
    catalog.filter((item) => item.name),
    bindKeyword,
  )
  const totals = receiptTotals(rows)
  const missingCost = rows.filter((row) => !row.costYuan.trim()).length
  const option = 'staff-account-option'

  return (
    <StaffScreen
      title="收货入库"
      loading={data.loading}
      error={data.error}
      stale={data.data !== null}
      onRetry={data.refresh}
      live={live}
      updatedAt={data.updatedAt}
    >
      <View className="receiving-view">
        <View className="staff-section">
          <Field
            label="供应商"
            required
            value={supplier}
            onChange={(value) => {
              supplierTouched.current = true
              setSupplier(value)
            }}
            placeholder="例如：义乌拼豆批发"
            help={lastSupplier ? `已预填最近一次入库的供应商「${lastSupplier}」，不对就改` : ''}
            error={validate && !supplier.trim() ? '请填写供应商' : ''}
            disabled={busy}
          />
        </View>

        <View className="staff-section receiving-add">
          {/* 扫码区放大（2026-10-20）：货到时一手拿货一手扫，按钮要好按 */}
          <View className="receiving-scan">
            <ActionButton loading={busy} loadingText="请稍候" onClick={() => void scan()}>
              扫商品条码
            </ActionButton>
            <Text className="receiving-scan-note">对准包装上的条码；同一件再扫一次，数量加 1</Text>
          </View>
          {unknown && (
            <View className="receiving-unknown">
              <View className="staff-notice" role="alert">
                <Text>
                  条码 {unknown.barcode}：
                  {unknown.canBind
                    ? '还没登记到商品。可以绑定到一件已有商品；新商品请在电脑后台「商品与库存」建资料。'
                    : `${unboundBarcodeMessage}。也可以按名称搜索添加。`}
                </Text>
              </View>
              {unknown.canBind && (
                <>
                  <Field
                    label="搜索要绑定的商品"
                    value={bindKeyword}
                    onChange={setBindKeyword}
                    placeholder="商品名称"
                    disabled={busy}
                  />
                  <View className="staff-account-list">
                    {bindMatches.map((item) => (
                      <Button
                        key={item.id}
                        className={option}
                        ariaLabel={`把条码 ${unknown.barcode} 绑定到${catalogLabel(item)}`}
                        disabled={busy}
                        onClick={() => void bind(item)}
                      >
                        <Text className="grow">{catalogLabel(item)}</Text>
                        <Text className="muted">{item.barcode ? `已有条码 ${item.barcode}` : '未登记条码'}</Text>
                      </Button>
                    ))}
                  </View>
                  {!!bindKeyword.trim() && !bindMatches.length && (
                    <Text className="field-help">没有匹配的商品，换个关键字试试。</Text>
                  )}
                </>
              )}
              <Button className="text-button" disabled={busy} onClick={() => setUnknown(null)}>
                {unknown.canBind ? '先不绑定' : '知道了'}
              </Button>
            </View>
          )}
          <Field
            label="按名称搜索"
            value={keyword}
            onChange={setKeyword}
            placeholder="商品名称或条码"
            disabled={busy}
          />
          <View className="staff-account-list">
            {matches.map((item) => (
              <Button
                key={item.id}
                className={option}
                ariaLabel={`加入${catalogLabel(item)}，当前库存 ${stockOf(item.id)} 件`}
                disabled={busy}
                onClick={() => add(item)}
              >
                <Text className="grow">{catalogLabel(item)}</Text>
                <Text className="muted">库存 {stockOf(item.id)} 件</Text>
              </Button>
            ))}
          </View>
          {!!keyword.trim() && !matches.length && (
            <Text className="field-help">没有匹配的商品。新商品请在电脑后台「商品与库存」建资料。</Text>
          )}
        </View>

        <View className="staff-section">
          <Text className="staff-section-title">这次收到的 · {rows.length} 种</Text>
          {!rows.length && <Text className="staff-empty">还没有商品，先扫码或按名称搜索添加。</Text>}
          {rows.map((row, index) => {
            const label = labelOf(row.productId)
            const item = itemOf(row.productId)
            const last = lastUnitCost(prefill, row.productId)
            const errors = validate ? rowErrors(row) : {}
            // 第一次进货、还没填进价的那行标红：没有上次进价可沿用，必须填
            const missing = last === undefined && !row.costYuan.trim()
            return (
              <View className={`receiving-row ${missing ? 'receiving-row-missing' : ''}`} key={row.productId}>
                <View className="receiving-row-heading">
                  <Text className="strong grow">{label}</Text>
                  <Button
                    className="text-button text-danger"
                    ariaLabel={`删除${label}这一行`}
                    disabled={busy}
                    onClick={() => setRows((previous) => previous.filter((_, i) => i !== index))}
                  >
                    删除
                  </Button>
                </View>
                <Text className="staff-list-meta">
                  当前库存 {stockOf(row.productId)} 件（参考）{item?.barcode ? ` · 条码 ${item.barcode}` : ''}
                </Text>
                <Stepper
                  label={`${label} · 数量`}
                  value={row.quantity}
                  onChange={(value) => update(index, 'quantity', value)}
                  error={errors.quantity || ''}
                  disabled={busy}
                />
                <Field
                  label={`${label} · 进价（元）`}
                  required
                  type="digit"
                  value={row.costYuan}
                  onChange={(value) => update(index, 'costYuan', value)}
                  help={last === undefined ? '第一次进货，要填进价' : `上次进价 ¥${money(last)}`}
                  error={errors.cost || ''}
                  disabled={busy}
                />
              </View>
            )
          })}
          <Field label="备注（选填）" value={note} onChange={setNote} placeholder="例如：到货单号" disabled={busy} />
        </View>

        <View className="receiving-summary">
          <View className="receiving-totals">
            <Text>
              {rows.length} 种 · 合计 {totals.quantity} 件
            </Text>
            <Text className="strong">¥{money(totals.cents)}</Text>
          </View>
          {missingCost > 0 ? (
            <Text className="receiving-missing-note">还有 {missingCost} 行没填进价</Text>
          ) : (
            !totals.complete && <Text className="field-help">有数量或进价没填对的行，没算进合计。</Text>
          )}
          {notice && (
            <View className="staff-notice" role="alert">
              <Text>{notice}</Text>
            </View>
          )}
          {error && (
            <View className="field-error" role="alert">
              {error}
            </View>
          )}
          <ActionButton loading={busy} loadingText="正在入库" disabled={!rows.length} onClick={submit}>
            确认入库
          </ActionButton>
          <Text className="field-help">新建商品、改商品资料、盘点和库存流水在电脑后台「商品与库存」。</Text>
        </View>
      </View>
    </StaffScreen>
  )
}
