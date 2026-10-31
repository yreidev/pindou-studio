import { Button, Card, DatePicker, Tag, TextArea, Toast, Typography } from '@douyinfe/semi-ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { announcementQuery, storefrontApi, type Announcement } from '../../api/storefront'
import { Field } from '../../components/Field'
import { confirmDialog } from '../../components/confirm'
import { dateTime, storeToday } from '../../lib/format'
import { announcementProblem, announcementStatus, maxAnnouncement } from './patterns'

/** 日期选择器给的本地日历日 → YYYY-MM-DD（选的是日历上的那一天，就是门店的那一天）。 */
const calendarDay = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

/**
 * 首页公告：一段文字（200 字以内，可以换行），可设到期日（到期那天还显示，过了那天顾客看不到）。首页只显示第一行，点开看全文。
 * 保存后顾客下次打开首页就看到；清除就是删掉。
 */
export function AnnouncementCard({ announcement }: { announcement: Announcement | null }) {
  const queryClient = useQueryClient()
  // 换了公告（别人保存、实时推送）就按新的重新填：key 用更新时刻
  return (
    <AnnouncementEditor
      key={announcement?.updatedAt ?? 'none'}
      announcement={announcement}
      onSaved={(saved) => queryClient.setQueryData(announcementQuery().queryKey, saved)}
    />
  )
}

function AnnouncementEditor({
  announcement,
  onSaved,
}: {
  announcement: Announcement | null
  onSaved: (view: { announcement: Announcement | null }) => void
}) {
  const [body, setBody] = useState(announcement?.body ?? '')
  const [expiresOn, setExpiresOn] = useState(announcement?.expiresOn ?? '')
  const today = storeToday()
  const problem = announcementProblem(body)
  const pastDate = expiresOn !== '' && expiresOn < today
  const dirty = body.trim() !== (announcement?.body ?? '') || expiresOn !== (announcement?.expiresOn ?? '')
  const status = announcementStatus(announcement)

  const save = useMutation({
    mutationFn: (input: { body: string; expiresOn: string | null }) => storefrontApi.saveAnnouncement(input),
    onSuccess: (saved) => {
      onSaved(saved)
      Toast.success(saved.announcement ? '公告已保存，顾客打开首页就能看到' : '公告已清除')
    },
    onError: (error) => Toast.error((error as Error).message),
  })

  const clear = async () => {
    const ok = await confirmDialog({
      title: '清除首页公告',
      content: '清除后首页不再显示公告这一行。',
      okText: '清除公告',
      okType: 'danger',
    })
    if (ok) save.mutate({ body: '', expiresOn: null })
  }

  return (
    <Card
      title="首页公告"
      style={{ marginBottom: 16 }}
      headerExtraContent={<Tag color={status.color}>{status.label}</Tag>}
    >
      <Field
        label="公告文字"
        help={`首页只显示第一行，顾客点开看全文。最多 ${maxAnnouncement} 个字，可以换行。`}
        errors={problem ? [problem] : []}
      >
        {(control) => (
          <TextArea
            {...control}
            autosize={{ minRows: 2, maxRows: 6 }}
            maxCount={maxAnnouncement}
            placeholder="如：10 月 22 日店休一天，23 日照常营业"
            disabled={save.isPending}
            value={body}
            onChange={setBody}
          />
        )}
      </Field>
      <Field
        label="显示到"
        help="到期那天还显示，过了那天自动不显示；不填就一直显示，直到清除。"
        errors={pastDate ? ['到期日不能早于今天'] : []}
        labelMode="group"
      >
        {() => (
          <DatePicker
            type="date"
            format="yyyy-MM-dd"
            placeholder="不过期"
            aria-label="显示到"
            style={{ width: 200 }}
            disabled={save.isPending}
            value={expiresOn || undefined}
            disabledDate={(date) => Boolean(date) && calendarDay(date as Date) < today}
            onChange={(_, text) => setExpiresOn(typeof text === 'string' ? text : '')}
          />
        )}
      </Field>
      <div className="toolbar" style={{ marginBottom: 0 }}>
        <Button
          theme="solid"
          type="primary"
          disabled={!dirty || !body.trim() || Boolean(problem) || pastDate}
          loading={save.isPending}
          onClick={() => save.mutate({ body: body.trim(), expiresOn: expiresOn || null })}
        >
          保存公告
        </Button>
        {announcement ? (
          <Button type="danger" disabled={save.isPending} onClick={() => void clear()}>
            清除公告
          </Button>
        ) : null}
        {announcement ? (
          <Typography.Text type="tertiary" size="small">
            最后修改 {dateTime(announcement.updatedAt)}
          </Typography.Text>
        ) : null}
      </div>
    </Card>
  )
}
