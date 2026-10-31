import { IconArrowDown, IconArrowUp, IconUpload } from '@douyinfe/semi-icons'
import { Button, Card, Input, Modal, Select, Spin, Switch, Table, Tag, Toast, Typography } from '@douyinfe/semi-ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { ApiError } from '../../api/client'
import {
  patternImageUrl,
  patternLibraryQuery,
  storefrontApi,
  type Pattern,
  type PatternLibrary,
  type PatternUpdate,
} from '../../api/storefront'
import { Field } from '../../components/Field'
import { confirmDialog, dialogButtons } from '../../components/confirm'
import { acceptedTypes, fileProblem, nameFromFile, prepareImage, type PreparedImage } from './image'
import { categoryLabel, moveId, newDaysLeft, patternNameProblem } from './patterns'

/** 写操作都回整个图纸库：直接替换缓存；排序撞上别人的增删（409 order_outdated）时重读。 */
export function useLibraryMutation<T>(run: (input: T) => Promise<PatternLibrary>, done?: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: run,
    onSuccess: (library) => {
      queryClient.setQueryData(patternLibraryQuery().queryKey, library)
      if (done) Toast.success(done)
    },
    onError: (error) => {
      Toast.error((error as Error).message)
      if (error instanceof ApiError && (error.code === 'order_outdated' || error.status === 404))
        void queryClient.invalidateQueries({ queryKey: patternLibraryQuery().queryKey })
    },
  })
}

/**
 * 图纸：员工上传、改名字和分类、换图、上下架、排顺序、删除。顾客端按这里的顺序看上架的；首页「本周上新」上新的在前、
 * 不够按这里的顺序补。新传的排在最前面。
 */
export function PatternsCard({ library }: { library: PatternLibrary }) {
  const [editing, setEditing] = useState<Pattern | 'new' | null>(null)
  const ids = library.patterns.map((pattern) => pattern.id)
  const order = useLibraryMutation(storefrontApi.order)
  const toggle = useLibraryMutation((pattern: Pattern) =>
    storefrontApi.update(pattern.id, { published: !pattern.published }),
  )
  const remove = useLibraryMutation(storefrontApi.remove, '图纸已删除')
  const busy = order.isPending || toggle.isPending || remove.isPending
  const now = new Date()

  const confirmRemove = async (pattern: Pattern) => {
    const ok = await confirmDialog({
      title: `删除图纸「${pattern.name}」`,
      content: '删除后顾客端不再显示，图片也一起删掉，不能恢复。只是暂时不想给顾客看的话，点「下架」就行。',
      okText: '删除图纸',
      okType: 'danger',
    })
    if (ok) remove.mutate(pattern.id)
  }

  return (
    <Card
      title="图纸"
      style={{ marginBottom: 16 }}
      headerExtraContent={
        <Button theme="solid" type="primary" icon={<IconUpload />} onClick={() => setEditing('new')}>
          上传图纸
        </Button>
      }
    >
      <Typography.Paragraph type="tertiary" size="small" style={{ marginBottom: 12 }}>
        上架的图纸顾客在小程序「图纸」页看，第一次上架起 7
        天标「上新」、排进首页「本周上新」。下架的顾客看不到，可以随时再上架。
      </Typography.Paragraph>
      <Table
        size="small"
        rowKey="id"
        pagination={false}
        dataSource={library.patterns}
        empty="还没有图纸，点右上角「上传图纸」传第一张。"
        columns={[
          {
            title: '图',
            width: 88,
            render: (_: unknown, pattern: Pattern) => (
              <img
                className="pattern-thumb"
                src={patternImageUrl(pattern.thumbnailPath)}
                alt={pattern.name}
                width={64}
                height={64}
              />
            ),
          },
          { title: '名字', dataIndex: 'name' },
          {
            title: '分类',
            width: 140,
            render: (_: unknown, pattern: Pattern) => categoryLabel(library.categories, pattern.categoryId),
          },
          {
            title: '状态',
            width: 180,
            render: (_: unknown, pattern: Pattern) => {
              const days = newDaysLeft(pattern, now)
              return (
                <span className="toolbar" style={{ margin: 0, gap: 4 }}>
                  {pattern.published ? <Tag color="green">上架中</Tag> : <Tag color="grey">未上架</Tag>}
                  {days ? <Tag color="red">上新 · 还剩 {days} 天</Tag> : null}
                </span>
              )
            },
          },
          {
            title: '操作',
            width: 340,
            render: (_: unknown, pattern: Pattern, index: number) => (
              <span className="toolbar" style={{ margin: 0, gap: 4 }}>
                <Button
                  size="small"
                  theme="borderless"
                  icon={<IconArrowUp />}
                  aria-label={`${pattern.name} 上移`}
                  disabled={busy || index === 0}
                  onClick={() => order.mutate(moveId(ids, pattern.id, -1))}
                />
                <Button
                  size="small"
                  theme="borderless"
                  icon={<IconArrowDown />}
                  aria-label={`${pattern.name} 下移`}
                  disabled={busy || index === ids.length - 1}
                  onClick={() => order.mutate(moveId(ids, pattern.id, 1))}
                />
                <Button size="small" disabled={busy} onClick={() => setEditing(pattern)}>
                  修改
                </Button>
                <Button size="small" disabled={busy} onClick={() => toggle.mutate(pattern)}>
                  {pattern.published ? '下架' : '上架'}
                </Button>
                <Button
                  size="small"
                  type="danger"
                  theme="borderless"
                  disabled={busy}
                  onClick={() => void confirmRemove(pattern)}
                >
                  删除
                </Button>
              </span>
            ),
          },
        ]}
      />
      {editing ? (
        <PatternDialog
          library={library}
          pattern={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </Card>
  )
}

/** 上传或修改一张图纸：选图（浏览器里先缩小）、名字、分类；上传时还能选立即上架还是先存着。 */
function PatternDialog({
  library,
  pattern,
  onClose,
}: {
  library: PatternLibrary
  pattern: Pattern | null
  onClose: () => void
}) {
  const fileInput = useRef<HTMLInputElement>(null)
  const [image, setImage] = useState<PreparedImage | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [imageProblem, setImageProblem] = useState<string | null>(null)
  const [name, setName] = useState(pattern?.name ?? '')
  const [categoryId, setCategoryId] = useState<string>(pattern?.categoryId ?? '')
  const [published, setPublished] = useState(true)
  const [touched, setTouched] = useState(false)
  const nameProblem = patternNameProblem(name)

  const save = useLibraryMutation(
    (input: { create: true; image: string } | { create: false; update: PatternUpdate }) =>
      input.create
        ? storefrontApi.upload({ name: name.trim(), categoryId: categoryId || null, published, image: input.image })
        : storefrontApi.update(pattern!.id, input.update),
    pattern ? '图纸已修改' : published ? '图纸已上传并上架' : '图纸已上传，还没上架',
  )

  const pick = async (file: File | undefined) => {
    if (!file) return
    const problem = fileProblem(file)
    setImageProblem(problem)
    if (problem) return
    setPreparing(true)
    try {
      setImage(await prepareImage(file))
      if (!name.trim()) setName(nameFromFile(file.name))
    } catch (error) {
      setImage(null)
      setImageProblem(error instanceof Error ? error.message : '读不了这张图片，请换一张')
    } finally {
      setPreparing(false)
    }
  }

  // 停用的分类不能再放图纸进去；这张图纸本来就在停用的分类里时，照样列出它（选中但标明已停用）
  const options = [
    { value: '', label: '不分类' },
    ...library.categories
      .filter((category) => category.enabled || category.id === pattern?.categoryId)
      .map((category) => ({
        value: category.id,
        label: categoryLabel(library.categories, category.id),
        disabled: !category.enabled,
      })),
  ]
  const update: PatternUpdate = {}
  if (pattern) {
    if (name.trim() !== pattern.name) update.name = name.trim()
    if ((categoryId || null) !== pattern.categoryId) update.categoryId = categoryId || null
    if (image) update.image = image.dataUrl
  }
  const ready = pattern ? Object.keys(update).length > 0 : Boolean(image)
  const submit = () => {
    setTouched(true)
    if (nameProblem || !ready || preparing) return
    if (pattern) save.mutate({ create: false, update }, { onSuccess: onClose })
    else save.mutate({ create: true, image: image!.dataUrl }, { onSuccess: onClose })
  }
  const previewSrc = image?.dataUrl ?? (pattern ? patternImageUrl(pattern.imagePath) : null)

  return (
    <Modal
      title={pattern ? `修改图纸「${pattern.name}」` : '上传图纸'}
      visible
      maskClosable={false}
      width={560}
      onCancel={onClose}
      okText={pattern ? '保存修改' : '上传'}
      onOk={submit}
      {...dialogButtons}
      okButtonProps={{ ...dialogButtons.okButtonProps, disabled: !ready || preparing, loading: save.isPending }}
    >
      <Field
        label="图片"
        help="JPG 或 PNG，不超过 5 MB；上传前会自动缩到长边 1600 像素。"
        errors={imageProblem ? [imageProblem] : []}
        labelMode="group"
      >
        {() => (
          <div className="pattern-picker">
            <input
              ref={fileInput}
              type="file"
              accept={acceptedTypes.join(',')}
              hidden
              data-testid="pattern-file"
              onChange={(event) => {
                void pick(event.target.files?.[0])
                event.target.value = ''
              }}
            />
            {previewSrc ? <img className="pattern-preview" src={previewSrc} alt="图纸预览" /> : null}
            <div className="toolbar" style={{ margin: 0 }}>
              <Button disabled={preparing || save.isPending} onClick={() => fileInput.current?.click()}>
                {previewSrc ? '换一张图…' : '选择图片…'}
              </Button>
              {preparing ? <Spin size="small" /> : null}
              {image ? (
                <Typography.Text type="tertiary" size="small">
                  {image.width} × {image.height}
                </Typography.Text>
              ) : null}
            </div>
          </div>
        )}
      </Field>
      <Field
        label="名字"
        required
        help="顾客在图纸卡片下面看到的名字，最多 20 个字。"
        errors={touched && nameProblem ? [nameProblem] : []}
      >
        {(control) => (
          <Input
            {...control}
            placeholder="如 草莓小熊"
            maxLength={40}
            showClear
            disabled={save.isPending}
            value={name}
            onChange={setName}
            onBlur={() => setTouched(true)}
          />
        )}
      </Field>
      <Field label="分类" help="顾客在图纸页按分类筛选；分类在下面的「图纸分类」里管。" labelMode="labelledby">
        {(control) => (
          <Select
            {...control}
            style={{ width: 240 }}
            optionList={options}
            disabled={save.isPending}
            value={categoryId}
            onChange={(value) => setCategoryId(String(value ?? ''))}
          />
        )}
      </Field>
      {pattern ? null : (
        <Field label="立即上架" help="关掉就先存着，顾客看不到，之后在列表里点「上架」。">
          {(control) => <Switch {...control} checked={published} disabled={save.isPending} onChange={setPublished} />}
        </Field>
      )}
    </Modal>
  )
}
