import { Banner, Button, Descriptions, Modal, Spin, TextArea, Toast, Typography } from '@douyinfe/semi-ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useBlocker } from '@tanstack/react-router'
import { useState } from 'react'
import { ApiError } from '../../api/client'
import { Field } from '../../components/Field'
import { loyaltySettingsQuery, rulePreviewQuery, rulesApi, type CatalogItem, type LoyaltyRule } from '../../api/rules'
import { ruleKindNames, ruleSummary, sameContent } from './display'
import { impactError, impactLimit } from './form'
import { confirmDiscard } from './RuleEditor'

/** 打开确认框时的快照：要发布或停用的草稿、当时生效的版本、当时读到的规则设置版本。 */
export interface PublishTarget {
  action: 'publish' | 'disable'
  rule: LoyaltyRule
  active?: LoyaltyRule
  version: string
}

const consequence = {
  publish:
    '发布后，新的交易按下面的内容计算，顾客端随即可见。已获得的等级、已充值的余额与积分、已领取的福利和已购买的套餐保留原记录，不重算历史。',
  disable: '停用后，顾客看不到这项规则，新的交易不再适用。已获得的权益和历史记录全部保留，之后可以再次发布。',
}

/**
 * 老板发布或停用规则的确认框：写清后果、展示服务端计算示例、必须填写影响说明。
 * 版本绑定打开时读到的规则设置；409 时提示重新读取，读到最新内容和计算示例后由老板再次确认，不自动重提。
 */
export function PublishDialog({
  target: opened,
  others,
  products,
  onClose,
}: {
  target: PublishTarget
  /** 同类正在生效的其他规则（消费积分、积分抵扣、自由计时价、陪客费全店只能各启用一项） */
  others: LoyaltyRule[]
  products: CatalogItem[]
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [target, setTarget] = useState(opened)
  const [impact, setImpact] = useState('')
  const [touched, setTouched] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [rereading, setRereading] = useState(false)
  const [gone, setGone] = useState(false)
  const publishing = target.action === 'publish'
  const kindName = ruleKindNames[target.rule.kind]
  // 停用不需要计算示例；发布前必须拿到服务端算的示例
  const preview = useQuery({ ...rulePreviewQuery(target.rule), enabled: publishing })

  const submit = useMutation({
    mutationFn: () => (publishing ? rulesApi.publish : rulesApi.disable)(target.rule.id, target.version, impact.trim()),
    onSuccess: () => {
      Toast.success(`${publishing ? '已发布' : '已停用'}「${target.rule.name}」`)
      void queryClient.invalidateQueries()
      onClose()
    },
  })
  // 写了影响说明还没提交就离开（浏览器后退、切页面）：先确认，放弃就关掉确认框
  const unsaved = impact.trim() !== '' && !submit.isSuccess
  useBlocker({
    shouldBlockFn: async () => {
      if (!(await confirmDiscard('影响说明还没有提交，离开后要重新填写。'))) return true
      onClose()
      return false
    },
    disabled: !unsaved,
    enableBeforeUnload: unsaved,
  })

  const conflict = submit.error instanceof ApiError && submit.error.status === 409
  const error = touched ? impactError(impact) : null
  // 消费积分、积分抵扣、自由计时价、陪客费全店同时只能生效一项（后端同样拒绝）
  const single = ['earn', 'redeem', 'free_timing', 'companion'].includes(target.rule.kind)
  const competing = publishing && single ? others : []

  const confirm = () => {
    setTouched(true)
    if (impactError(impact)) {
      document.querySelector<HTMLElement>('[data-impact-field] textarea')?.focus()
      return
    }
    submit.mutate()
  }

  const rereadSettings = async () => {
    setRereading(true)
    try {
      const fresh = await queryClient.fetchQuery({ ...loyaltySettingsQuery(), staleTime: 0 })
      const latest = fresh.drafts[target.rule.id]
      if (!latest) {
        setGone(true)
        setNotice('这条规则已不存在，请关闭后刷新页面。')
        return
      }
      const active = fresh.rules.find((rule) => rule.id === latest.id)
      const changed =
        !sameContent(latest, target.rule) ||
        Boolean(active) !== Boolean(target.active) ||
        Boolean(active && target.active && !sameContent(active, target.active))
      setTarget({ ...target, rule: latest, active, version: fresh.version })
      setNotice(
        changed
          ? '规则在此期间被改过，下面已换成最新的内容' + (publishing ? '和计算示例' : '') + '，请重新核对后再确认。'
          : '规则内容没有变化，核对无误后再次确认即可。',
      )
      submit.reset()
    } catch (failure) {
      Toast.error(failure instanceof Error ? failure.message : '重新读取失败')
    } finally {
      setRereading(false)
    }
  }

  const changedFromActive = target.active && !sameContent(target.active, target.rule)
  const rows = publishing
    ? [
        { key: '规则', value: `${kindName} · ${target.rule.name}` },
        { key: '将发布的内容', value: ruleSummary(target.rule, products) },
        ...(target.active
          ? [
              {
                key: '当前生效',
                value: changedFromActive ? ruleSummary(target.active, products) : '与将发布的内容相同',
              },
            ]
          : [{ key: '当前生效', value: '没有生效中的版本' }]),
      ]
    : [
        { key: '规则', value: `${kindName} · ${target.rule.name}` },
        { key: '正在生效的内容', value: target.active ? ruleSummary(target.active, products) : '当前未生效' },
      ]

  return (
    <Modal
      visible
      width={600}
      title={`${publishing ? '发布' : '停用'}${kindName}「${target.rule.name}」`}
      onCancel={() => {
        if (!submit.isPending) onClose()
      }}
      maskClosable={!submit.isPending}
      footer={
        <>
          <Button onClick={onClose} disabled={submit.isPending}>
            取消
          </Button>
          <Button
            theme="solid"
            type={publishing ? 'primary' : 'danger'}
            onClick={confirm}
            loading={submit.isPending}
            disabled={gone || (publishing && !preview.isSuccess)}
          >
            {publishing ? '确认发布' : '确认停用'}
          </Button>
        </>
      }
    >
      <div className="rule-dialog">
        <Banner type={publishing ? 'info' : 'warning'} closeIcon={null} description={consequence[target.action]} />
        {submit.error ? (
          <Banner
            type="danger"
            closeIcon={null}
            title={conflict ? `没有${publishing ? '发布' : '停用'}` : '操作失败'}
            description={
              <span>
                {submit.error.message}
                {conflict ? (
                  <>
                    。请重新读取最新设置，核对后再确认。{' '}
                    <Button size="small" onClick={() => void rereadSettings()} loading={rereading}>
                      重新读取
                    </Button>
                  </>
                ) : null}
              </span>
            }
          />
        ) : null}
        {notice ? <Banner type="warning" closeIcon={null} title="已读取最新设置" description={notice} /> : null}
        {competing.length ? (
          <Banner
            type="warning"
            closeIcon={null}
            description={`全店同时只能启用一项${kindName}规则，「${competing.map((rule) => rule.name).join('、')}」正在生效，需先停用。`}
          />
        ) : null}

        <Descriptions data={rows} />

        {publishing ? (
          <div className="rule-preview-box">
            <Typography.Text strong>服务端计算示例</Typography.Text>
            {preview.isPending ? (
              <div>
                <Spin /> <Typography.Text type="tertiary">正在计算…</Typography.Text>
              </div>
            ) : preview.isError ? (
              <Banner
                type="danger"
                closeIcon={null}
                description={`${preview.error.message}。计算示例算不出来的草稿不能发布，请先修改草稿。`}
              />
            ) : (
              <Typography.Paragraph className="rule-preview-text">{preview.data}</Typography.Paragraph>
            )}
          </div>
        ) : null}

        <div data-impact-field>
          <Field
            label="影响说明"
            required
            help="记入发布历史与审计，之后不能修改。"
            errors={error ? [error] : undefined}
          >
            {(control) => (
              <TextArea
                {...control}
                value={impact}
                onChange={(value) => setImpact(value)}
                onBlur={() => setTouched(true)}
                maxCount={impactLimit}
                autosize={{ minRows: 2, maxRows: 5 }}
                placeholder={
                  publishing
                    ? '写给以后查账的人：为什么调整、影响哪些顾客，例如「换季调整充值赠送，只影响新充值」'
                    : '例如「活动结束停用，已领取的福利照常使用」'
                }
              />
            )}
          </Field>
        </div>
      </div>
    </Modal>
  )
}
