import {
  Banner,
  Button,
  Input,
  Radio,
  RadioGroup,
  SideSheet,
  Space,
  Switch,
  Toast,
  Typography,
} from '@douyinfe/semi-ui'
import { revalidateLogic, useForm, useStore } from '@tanstack/react-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useBlocker } from '@tanstack/react-router'
import { useState, type ReactNode } from 'react'
import { ApiError } from '../../api/client'
import { Field, type FieldControl, type FieldLabelMode } from '../../components/Field'
import { NamedSelect } from '../../components/NamedSelect'
import { loyaltySettingsQuery, rulesApi, type CatalogItem, type LoyaltyRule } from '../../api/rules'
import { modeNames, overtimeNames, ruleKindNames, ruleSummary, sameContent, scopeNames } from './display'
import { money } from '../../lib/format'
import { parseCount } from './units'
import {
  fieldOrder,
  formValues,
  graceField,
  hourlyCents,
  needsProduct,
  numericFields,
  productLabel,
  ruleFieldErrors,
  ruleFormSchema,
  toRule,
  untilCloseHelp,
  type RuleFieldKey,
} from './form'
import { confirmDialog } from '../../components/confirm'

/** 打开编辑时的快照：草稿（新建为空白规则）和当时读到的规则设置版本，保存时按它确认。 */
export interface EditTarget {
  rule: LoyaltyRule
  version: string
  /** 这条规则正在生效（编辑草稿不改变生效中的版本） */
  active: boolean
}

type Intent = { intent: 'save' | 'preview' }

/** 有未保存的输入时离开（关抽屉、切页面、浏览器后退）先问一声。 */
export function confirmDiscard(content = '草稿还没有保存，离开后刚才填写的内容会丢失。'): Promise<boolean> {
  return confirmDialog({
    title: '放弃未保存的修改？',
    content,
    okText: '放弃修改',
    cancelText: '继续编辑',
    okType: 'danger',
  })
}

/** 提交没通过时滚到第一个出错的字段并把光标放进去。 */
function focusField(key: RuleFieldKey) {
  window.setTimeout(() => {
    const row = document.querySelector<HTMLElement>(`[data-rule-field="${key}"]`)
    row?.scrollIntoView({ block: 'center' })
    row?.querySelector<HTMLElement>('input, textarea, [tabindex="0"]')?.focus({ preventScroll: true })
  }, 0)
}

/** 草稿表单的一项：标题、说明、错误由共用的字段外壳接到控件上；外面这层标出是哪个字段，提交没通过时定位用。 */
function FieldRow({
  name,
  label,
  help,
  errors,
  labelMode,
  children,
}: {
  name: RuleFieldKey
  label: string
  help?: string
  errors?: unknown[]
  labelMode?: FieldLabelMode
  children: (control: FieldControl) => ReactNode
}) {
  return (
    <div data-rule-field={name}>
      <Field label={label} help={help} errors={errors} labelMode={labelMode}>
        {children}
      </Field>
    </div>
  )
}

/**
 * 规则草稿编辑抽屉：新建或修改一条草稿。保存草稿不影响已发布的规则。
 * 版本绑定打开时读到的规则设置；别人在此期间改过设置会收到 409，提示重新读取、核对后再保存，
 * 已填的内容保留，不自动换版本重提。
 */
export function RuleEditor({
  target,
  products,
  productsFailed,
  onClose,
}: {
  target: EditTarget
  products: CatalogItem[]
  productsFailed: boolean
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const kind = target.rule.kind
  const isNew = target.rule.id === ''
  const [initial] = useState(() => formValues(target.rule))
  const [initialJson] = useState(() => JSON.stringify(initial))
  // 保存时回传的版本，和用来判断「别人改过这条草稿」的基准
  const [base, setBase] = useState({ version: target.version, rule: target.rule })
  const [reread, setReread] = useState<{ changed?: LoyaltyRule } | null>(null)
  const [rereading, setRereading] = useState(false)
  // 计算示例只对算它时的那份输入有效，改了内容就提示重新生成
  const [preview, setPreview] = useState<{ forValues: string; text?: string; error?: string } | null>(null)

  const save = useMutation({
    mutationFn: (rule: LoyaltyRule) => rulesApi.save(rule, base.version),
    onSuccess: (saved) => {
      Toast.success(`草稿已保存：${saved.name}`)
      void queryClient.invalidateQueries()
      onClose()
    },
  })
  const previewRule = useMutation({ mutationFn: (rule: LoyaltyRule) => rulesApi.preview(rule) })

  const form = useForm({
    defaultValues: initial,
    validationLogic: revalidateLogic(),
    validators: { onDynamic: ruleFormSchema(kind) },
    onSubmitMeta: { intent: 'save' } as Intent,
    onSubmit: async ({ value, meta }) => {
      const rule = toRule(target.rule, value)
      if (meta.intent === 'preview') {
        const forValues = JSON.stringify(value)
        try {
          setPreview({ forValues, text: await previewRule.mutateAsync(rule) })
        } catch (error) {
          setPreview({ forValues, error: error instanceof Error ? error.message : '计算示例读取失败' })
        }
        return
      }
      try {
        await save.mutateAsync(rule)
      } catch {
        // 错误显示在抽屉顶部，输入保留
      }
    },
    onSubmitInvalid: ({ value }) => {
      const errors = ruleFieldErrors(kind, value)
      const first = fieldOrder(kind, value.scope, value.untilClose).find((key) => errors[key])
      if (first) focusField(first)
    },
  })

  const valuesJson = useStore(form.store, (state) => JSON.stringify(state.values))
  const scope = useStore(form.store, (state) => state.values.scope)
  const overtime = useStore(form.store, (state) => state.values.overtime)
  const untilClose = useStore(form.store, (state) => kind === 'package' && state.values.untilClose)
  const boardUses = useStore(form.store, (state) => parseCount(state.values.boardUses) ?? 0)
  // 没有续时方案（每次续时为 0 或没填好）时不能选「按续时方案自动加收」
  const hasRenewal = useStore(form.store, (state) => (parseCount(state.values.renewalMinutes) ?? 0) > 0)
  const hourly = useStore(form.store, (state) =>
    kind === 'free_timing' ? hourlyCents(state.values.amountCents) : null,
  )
  const submitting = useStore(form.store, (state) => state.isSubmitting)
  const dirty = valuesJson !== initialJson

  // 切页面、浏览器后退、关标签页：有未保存的输入先确认。放弃就连抽屉一起关掉——
  // 后退可能只是换了标签页，页面还在，抽屉不关就成了「放弃了但还开着」。
  useBlocker({
    shouldBlockFn: async () => {
      if (!(await confirmDiscard())) return true
      onClose()
      return false
    },
    disabled: !dirty,
    enableBeforeUnload: dirty,
  })

  const requestClose = async () => {
    if (submitting) return
    if (dirty && !(await confirmDiscard())) return
    onClose()
  }

  const conflict = save.error instanceof ApiError && save.error.status === 409

  const rereadSettings = async () => {
    setRereading(true)
    try {
      const fresh = await queryClient.fetchQuery({ ...loyaltySettingsQuery(), staleTime: 0 })
      const latest = isNew ? undefined : fresh.drafts[target.rule.id]
      setReread({ changed: latest && !sameContent(latest, base.rule) ? latest : undefined })
      setBase({ version: fresh.version, rule: latest ?? base.rule })
      save.reset()
    } catch (error) {
      Toast.error(error instanceof Error ? error.message : '重新读取失败')
    } finally {
      setRereading(false)
    }
  }

  const productOptions = products.map((item) => ({
    value: item.id,
    label: item.name || `未命名商品 · ${item.id.slice(0, 8)}`,
  }))

  const choice = (
    name: 'mode' | 'scope' | 'overtime',
    label: string,
    options: string[],
    names: Record<string, string>,
    disabled: Record<string, string> = {},
  ) => (
    <form.Field name={name}>
      {(field) => (
        <FieldRow name={name} label={label} errors={field.state.meta.errors} labelMode="radiogroup">
          {() => (
            <RadioGroup
              // 原生单选框按 name 分组：不给 name 时 Semi 都叫 default，生日福利的「领取时间」「福利内容」两组在同一个表单里，
              // 选了一组，另一组的勾就被浏览器取消（React 还会把旧的那一格勾回来）
              name={`rule-${name}`}
              type={name === 'overtime' ? 'default' : 'button'}
              direction={name === 'overtime' ? 'vertical' : 'horizontal'}
              value={field.state.value}
              onChange={(event) => field.handleChange(String(event.target.value))}
            >
              {options.map((option) => (
                <Radio key={option} value={option} disabled={Boolean(disabled[option])} extra={disabled[option]}>
                  {names[option]}
                </Radio>
              ))}
            </RadioGroup>
          )}
        </FieldRow>
      )}
    </form.Field>
  )

  const product = needsProduct(kind, scope) ? (
    <form.Field name="productId">
      {(field) => (
        <FieldRow
          name="productId"
          label={productLabel(kind)}
          help={kind === 'exchange' ? '兑换时扣积分并出库一件，须先在库存里登记该商品。' : '领取后由员工核销出库。'}
          errors={field.state.meta.errors}
          labelMode="labelledby"
        >
          {(control) => (
            <>
              {productsFailed ? (
                <Banner
                  type="warning"
                  closeIcon={null}
                  description="商品目录读取失败，请稍后刷新页面再选。"
                  style={{ marginBottom: 8 }}
                />
              ) : null}
              <NamedSelect
                {...control}
                label={productLabel(kind)}
                style={{ width: '100%' }}
                filter
                placeholder="选择库存商品"
                value={field.state.value || undefined}
                onChange={(value) => field.handleChange(String(value ?? ''))}
                optionList={productOptions}
                emptyContent="没有匹配的商品"
              />
            </>
          )}
        </FieldRow>
      )}
    </form.Field>
  ) : null

  const showPreview = preview && preview.forValues === valuesJson

  return (
    <SideSheet
      visible
      width={560}
      title={`${isNew ? '新建' : '编辑'}${ruleKindNames[kind]}草稿`}
      onCancel={() => void requestClose()}
      closeOnEsc
      footer={
        <Space>
          <Button onClick={() => void requestClose()} disabled={submitting}>
            取消
          </Button>
          <Button
            onClick={() => void form.handleSubmit({ intent: 'preview' })}
            loading={previewRule.isPending}
            disabled={submitting && !previewRule.isPending}
          >
            计算示例
          </Button>
          <Button
            theme="solid"
            type="primary"
            onClick={() => void form.handleSubmit({ intent: 'save' })}
            loading={save.isPending}
            disabled={submitting && !save.isPending}
          >
            保存草稿
          </Button>
        </Space>
      }
    >
      <form
        className="rule-form"
        onSubmit={(event) => {
          event.preventDefault()
          void form.handleSubmit({ intent: 'save' })
        }}
      >
        <Typography.Paragraph type="tertiary">
          保存草稿不影响营业；老板发布后，新的交易才按这里的设置计算。金额按元填写，比例按百分比填写。
        </Typography.Paragraph>
        {target.active ? (
          <Banner
            type="info"
            closeIcon={null}
            description="这条规则正在生效。保存草稿不会改变生效中的版本，老板发布修改后才替换。"
          />
        ) : null}

        {save.error ? (
          <Banner
            type="danger"
            closeIcon={null}
            title={conflict ? '没有保存' : '保存失败'}
            description={
              <span>
                {save.error.message}
                {conflict ? (
                  <>
                    。可能有人刚改过规则设置，请重新读取、核对后再保存，已填的内容会保留。{' '}
                    <Button size="small" onClick={() => void rereadSettings()} loading={rereading}>
                      重新读取
                    </Button>
                  </>
                ) : null}
              </span>
            }
          />
        ) : null}
        {reread ? (
          <Banner
            type="warning"
            closeIcon={null}
            title="已读取最新设置"
            description={
              reread.changed
                ? `这条草稿在你编辑期间被修改过，最新内容为：${reread.changed.name}，${ruleSummary(reread.changed, products)}。再次保存会以你现在填写的内容为准。`
                : '确认填写无误后再点「保存草稿」。'
            }
          />
        ) : null}

        <form.Field name="name">
          {(field) => (
            <FieldRow name="name" label="名称" errors={field.state.meta.errors}>
              {(control) => (
                <Input
                  {...control}
                  value={field.state.value}
                  onChange={(value) => field.handleChange(value)}
                  onBlur={field.handleBlur}
                  placeholder="顾客看到的名称，例如「黄金会员」「三小时畅玩」"
                />
              )}
            </FieldRow>
          )}
        </form.Field>

        {kind === 'tier' ? choice('mode', '升级方式', ['cumulative', 'single'], modeNames) : null}
        {kind === 'earn' ? choice('scope', '适用消费', ['all', 'goods', 'service'], scopeNames) : null}
        {kind === 'birthday' ? (
          <>
            {choice('mode', '领取时间', ['month', 'day'], modeNames)}
            {choice('scope', '福利内容', ['points', 'gift', 'discount'], scopeNames)}
          </>
        ) : null}
        {kind === 'exchange' ? product : null}

        {kind === 'package' ? (
          <form.Field name="untilClose">
            {(field) => (
              <FieldRow name="untilClose" label="到打烊" help={untilCloseHelp}>
                {(control) => (
                  <div>
                    <Switch
                      id={control.id}
                      aria-describedby={control['aria-describedby']}
                      checked={field.state.value}
                      onChange={(checked) => {
                        field.handleChange(checked)
                        // 到打烊不能续时：选着「按续时方案自动加收」时改回提示员工处理
                        if (checked && form.getFieldValue('overtime') === 'renewal')
                          form.setFieldValue('overtime', 'manual')
                      }}
                    />
                  </div>
                )}
              </FieldRow>
            )}
          </form.Field>
        ) : null}

        {numericFields(kind, scope, untilClose).map((spec) => (
          <form.Field key={spec.key} name={spec.key}>
            {(field) => (
              <FieldRow name={spec.key} label={spec.label} help={spec.help} errors={field.state.meta.errors}>
                {(control) => (
                  <Input
                    {...control}
                    value={field.state.value}
                    onChange={(value) => field.handleChange(value)}
                    onBlur={field.handleBlur}
                    suffix={spec.suffix}
                    inputMode={spec.unit === 'count' ? 'numeric' : 'decimal'}
                  />
                )}
              </FieldRow>
            )}
          </form.Field>
        ))}

        {kind === 'free_timing' ? (
          <Typography.Paragraph type="tertiary" className="rule-hourly">
            {hourly === null ? '填好每块的价后这里显示折合每小时多少。' : `折合每小时 ${money(hourly)}`}
          </Typography.Paragraph>
        ) : null}

        {kind === 'birthday' ? product : null}
        {kind === 'package'
          ? choice(
              'overtime',
              '超时处理',
              ['manual', 'free', 'renewal'],
              overtimeNames,
              // 已经选着它时不禁用，留给校验提示去填续时（否则选中项变灰、点不掉）
              overtime === 'renewal'
                ? {}
                : untilClose
                  ? { renewal: '到打烊的套餐不能续时' }
                  : hasRenewal
                    ? {}
                    : { renewal: '要先填每次续时和续时价格' },
            )
          : null}
        {kind === 'package' && overtime === 'renewal' ? (
          <form.Field name="overtimeGraceMinutes">
            {(field) => (
              <FieldRow
                name="overtimeGraceMinutes"
                label={graceField.label}
                help={graceField.help}
                errors={field.state.meta.errors}
              >
                {(control) => (
                  <Input
                    {...control}
                    value={field.state.value}
                    onChange={(value) => field.handleChange(value)}
                    onBlur={field.handleBlur}
                    suffix={graceField.suffix}
                    inputMode="numeric"
                  />
                )}
              </FieldRow>
            )}
          </form.Field>
        ) : null}
        {kind === 'redeem' ? (
          <form.Field name="stack">
            {(field) => (
              <FieldRow
                name="stack"
                label="与会员折扣叠加"
                help="关闭时，已享受会员价或生日折扣的订单不能再用积分抵扣。"
              >
                {(control) => (
                  <div>
                    <Switch
                      id={control.id}
                      aria-describedby={control['aria-describedby']}
                      checked={field.state.value}
                      onChange={(checked) => field.handleChange(checked)}
                    />
                  </div>
                )}
              </FieldRow>
            )}
          </form.Field>
        ) : null}

        <div className="rule-preview-box">
          <Typography.Text strong>计算示例</Typography.Text>
          {showPreview && preview.error ? (
            <Banner type="danger" closeIcon={null} description={preview.error} />
          ) : showPreview ? (
            <Typography.Paragraph className="rule-preview-text">{preview.text}</Typography.Paragraph>
          ) : (
            <Typography.Paragraph type="tertiary">
              {preview ? '内容改过了，' : ''}点「计算示例」由服务端按当前填写的内容算一遍，确认和预期一致再保存。
            </Typography.Paragraph>
          )}
          {showPreview && !preview.error && kind === 'recharge' && boardUses > 0 ? (
            <Typography.Paragraph>本方案同时送智能豆板 {boardUses} 次，次数不过期。</Typography.Paragraph>
          ) : null}
        </div>
      </form>
    </SideSheet>
  )
}
