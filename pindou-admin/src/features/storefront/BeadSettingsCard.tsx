import {
  Banner,
  Button,
  Card,
  Checkbox,
  Input,
  InputNumber,
  Radio,
  RadioGroup,
  Select,
  Table,
  Toast,
  Typography,
} from '@douyinfe/semi-ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { ApiError } from '../../api/client'
import { beadSettingsApi, beadSettingsQuery, type BeadSettings } from '../../api/beads'
import { Field } from '../../components/Field'
import { dateTime } from '../../lib/format'
import {
  beadSizeOptions,
  boxProblem,
  draftFrom,
  draftProblem,
  draftSummary,
  maxBoard,
  maxBox,
  minBoard,
  paletteById,
  paletteGroups,
  sameAsSaved,
  seriesOf,
  switchPalette,
  toInput,
  type BeadDraft,
} from './beads'

type Row = { code: string; hex: string }

/**
 * 做图纸用的豆子（画稿 AdminBeads）：顾客在「做图纸」里默认用这里的色卡、底板和豆子大小；色卡选的是这一套时，
 * 用豆清单上标出店里有没有、在几号盒，店里没有的颜色提示换成最接近的。只是默认值和提示，顾客可以换别的。
 * 改的时候别人保存了：没改过就跟着换成新的；改了一半就提示，保存会被拒，不悄悄覆盖。
 */
export function BeadSettingsCard({ settings }: { settings: BeadSettings }) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<BeadDraft>(() => draftFrom(settings))
  const [base, setBase] = useState(settings)
  const [seriesKey, setSeriesKey] = useState<string>()
  const dirty = !sameAsSaved(draft, base)
  const outdated = settings.revision !== base.revision

  // 别人保存了（实时推送重读）：这边没改过就直接换成新的（渲染时就换，React 文档「根据属性调整状态」的写法）
  if (outdated && !dirty) {
    setBase(settings)
    setDraft(draftFrom(settings))
  }

  const palette = paletteById(draft.palette)
  const series = useMemo(() => (palette ? seriesOf(palette) : []), [palette])
  const current = series.find((s) => s.key === seriesKey) ?? series[0]
  const rows: Row[] = useMemo(
    () => (palette && current ? palette.colors.filter((c) => current.codes.includes(c.code)) : []),
    [palette, current],
  )
  const problem = draftProblem(draft)

  const save = useMutation({
    mutationFn: () => beadSettingsApi.save(toInput(draft, base.revision)),
    onSuccess: (saved) => {
      queryClient.setQueryData(beadSettingsQuery().queryKey, saved)
      setBase(saved)
      setDraft(draftFrom(saved))
      Toast.success('已保存，顾客下次打开「做图纸」就用新的')
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'bead_settings_conflict') {
        Toast.error('别人刚改过，先看看最新的再改')
        void queryClient.invalidateQueries({ queryKey: beadSettingsQuery().queryKey })
        return
      }
      Toast.error((error as Error).message)
    },
  })

  const reset = (to: BeadSettings) => {
    setBase(to)
    setDraft(draftFrom(to))
    setSeriesKey(undefined)
  }
  const setAvailable = (codes: readonly string[], on: boolean) =>
    setDraft((d) => {
      const available = new Set(d.available)
      for (const code of codes) {
        if (on) available.add(code)
        else available.delete(code)
      }
      return { ...d, available }
    })

  return (
    <Card
      title="做图纸用的豆子"
      style={{ marginBottom: 16 }}
      headerExtraContent={
        <Typography.Text type="tertiary" size="small">
          {base.updatedAt ? `最后修改 ${dateTime(base.updatedAt)}` : '没改过（默认 MARD 221 色都有）'}
        </Typography.Text>
      }
    >
      <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
        顾客在小程序「做图纸」时，默认用这里的色卡、底板和豆子大小；色卡选的是这一套时，用豆清单上标出店里有没有、在几号盒，
        店里没有的颜色会提示换成最接近的。只是默认值和提示，顾客可以换别的色卡、别的底板。所有员工都能改，改了记操作记录。
      </Typography.Paragraph>
      {outdated ? (
        <Banner
          type="warning"
          fullMode={false}
          closeIcon={null}
          style={{ marginBottom: 16 }}
          description={
            <>
              别人刚改过做图纸用的豆子，这边的修改保存不了。
              <Button theme="borderless" size="small" onClick={() => reset(settings)}>
                放弃这边的修改，看最新的
              </Button>
            </>
          }
        />
      ) : null}
      <div className="bead-settings-fields">
        <Field label="色卡" help="店里豆子是哪个牌子、哪一套" labelMode="labelledby">
          {(control) => (
            <Select
              {...control}
              style={{ width: 240 }}
              value={draft.palette}
              disabled={save.isPending}
              onChange={(value) => {
                setDraft((d) => switchPalette(d, String(value)))
                setSeriesKey(undefined)
              }}
            >
              {paletteGroups.map((group) => (
                <Select.OptGroup key={group.label} label={group.label}>
                  {group.options.map((option) => (
                    <Select.Option key={option.value} value={option.value}>
                      {option.label}
                    </Select.Option>
                  ))}
                </Select.OptGroup>
              ))}
            </Select>
          )}
        </Field>
        <Field label="底板" help={`一块底板一边几格，${minBoard}～${maxBoard}`}>
          {(control) => (
            <InputNumber
              {...control}
              style={{ width: 160 }}
              min={minBoard}
              max={maxBoard}
              precision={0}
              suffix="格"
              disabled={save.isPending}
              value={draft.boardSize}
              onChange={(value) => setDraft((d) => ({ ...d, boardSize: typeof value === 'number' ? value : NaN }))}
            />
          )}
        </Field>
        <Field label="豆子大小" help="用来算成品有多大" labelMode="radiogroup">
          {() => (
            <RadioGroup
              type="button"
              name="bead-size"
              value={draft.beadSize}
              disabled={save.isPending}
              onChange={(event) => setDraft((d) => ({ ...d, beadSize: event.target.value as BeadDraft['beadSize'] }))}
            >
              {beadSizeOptions.map((option) => (
                <Radio key={option.value} value={option.value}>
                  {option.label}
                </Radio>
              ))}
            </RadioGroup>
          )}
        </Field>
      </div>
      <Typography.Title heading={6} style={{ margin: '8px 0 4px' }}>
        店里有的颜色和盒号
      </Typography.Title>
      <Typography.Paragraph type="tertiary" size="small" style={{ marginBottom: 12 }}>
        {draftSummary(draft)}。换色卡时店里有没有、盒号要重新填（同一个色号在不同牌子里是不同的颜色）。
      </Typography.Paragraph>
      {current ? (
        <>
          <div className="bead-series">
            <RadioGroup
              type="button"
              name="bead-series"
              aria-label="色号系列"
              value={current.key}
              onChange={(event) => setSeriesKey(String(event.target.value))}
            >
              {series.map((s) => (
                <Radio key={s.key} value={s.key}>
                  {s.name}
                </Radio>
              ))}
            </RadioGroup>
            <div className="bead-series-actions">
              <Button size="small" disabled={save.isPending} onClick={() => setAvailable(current.codes, true)}>
                这一系列都有
              </Button>
              <Button size="small" disabled={save.isPending} onClick={() => setAvailable(current.codes, false)}>
                这一系列都没有
              </Button>
            </div>
          </div>
          <Table
            key={`${draft.palette}:${current.key}`}
            size="small"
            rowKey="code"
            dataSource={rows}
            pagination={rows.length > 20 ? { pageSize: 20 } : false}
            columns={[
              {
                title: '店里有',
                width: 80,
                render: (_: unknown, row: Row) => (
                  <Checkbox
                    aria-label={`${row.code} 店里有`}
                    checked={draft.available.has(row.code)}
                    disabled={save.isPending}
                    onChange={(event) => setAvailable([row.code], Boolean(event.target.checked))}
                  />
                ),
              },
              {
                title: '颜色',
                width: 72,
                render: (_: unknown, row: Row) => (
                  <span className="bead-swatch" style={{ background: row.hex }} title={row.hex} aria-hidden />
                ),
              },
              { title: '色号', width: 120, dataIndex: 'code' },
              {
                title: '盒号',
                render: (_: unknown, row: Row) => {
                  const value = draft.boxes[row.code] ?? ''
                  const error = boxProblem(value)
                  return (
                    <Input
                      aria-label={`${row.code} 盒号`}
                      size="small"
                      style={{ width: 160 }}
                      placeholder="不填"
                      validateStatus={error ? 'error' : 'default'}
                      disabled={save.isPending}
                      value={value}
                      onChange={(text) => setDraft((d) => ({ ...d, boxes: { ...d.boxes, [row.code]: text } }))}
                    />
                  )
                },
              },
            ]}
          />
          <Typography.Text type="tertiary" size="small">
            {current.name} {current.codes.length} 种，盒号最多 {maxBox} 个字
          </Typography.Text>
        </>
      ) : null}
      {problem && dirty ? (
        <Banner type="danger" fullMode={false} closeIcon={null} description={problem} style={{ marginTop: 12 }} />
      ) : null}
      <div className="toolbar" style={{ marginTop: 16, marginBottom: 0 }}>
        <Button
          theme="solid"
          type="primary"
          disabled={!dirty || Boolean(problem) || outdated}
          loading={save.isPending}
          onClick={() => save.mutate()}
        >
          保存
        </Button>
        <Button disabled={!dirty || save.isPending} onClick={() => reset(settings)}>
          撤销修改
        </Button>
      </div>
    </Card>
  )
}
