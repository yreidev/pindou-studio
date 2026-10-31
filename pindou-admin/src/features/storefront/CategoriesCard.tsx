import { IconArrowDown, IconArrowUp } from '@douyinfe/semi-icons'
import { Button, Card, Input, Modal, Table, Tag, Typography } from '@douyinfe/semi-ui'
import { useState } from 'react'
import { storefrontApi, type PatternCategory, type PatternLibrary } from '../../api/storefront'
import { Field } from '../../components/Field'
import { confirmDialog, dialogButtons } from '../../components/confirm'
import { useLibraryMutation } from './PatternsCard'
import { categoryNameProblem, maxCategoryName, moveId, patternCounts } from './patterns'

/**
 * 图纸分类：加（排在最后）、改名、排顺序、停用或启用。停用后顾客端的筛选条里不出现，里面的图纸照样在「全部」里，
 * 也不能再把图纸放进去。没有图纸（含下架的）的分类可以删，删了名字就能再用（2026-10-20 业主定）。顾客端的筛选条按这里的顺序排。
 */
export function CategoriesCard({ library }: { library: PatternLibrary }) {
  const [editing, setEditing] = useState<PatternCategory | 'new' | null>(null)
  const ids = library.categories.map((category) => category.id)
  const counts = patternCounts(library.patterns)
  const order = useLibraryMutation(storefrontApi.orderCategories)
  const toggle = useLibraryMutation((category: PatternCategory) =>
    storefrontApi.updateCategory(category.id, { enabled: !category.enabled }),
  )
  const remove = useLibraryMutation(storefrontApi.removeCategory, '分类已删除')
  const busy = order.isPending || toggle.isPending || remove.isPending

  const confirmRemove = async (category: PatternCategory) => {
    const ok = await confirmDialog({
      title: `删除分类「${category.name}」？`,
      content: '删了这个名字就能再用。',
      okText: '删除分类',
      okType: 'danger',
    })
    if (ok) remove.mutate(category.id)
  }

  return (
    <Card title="图纸分类" headerExtraContent={<Button onClick={() => setEditing('new')}>添加分类</Button>}>
      <Table
        size="small"
        rowKey="id"
        pagination={false}
        dataSource={library.categories}
        empty="还没有分类。"
        columns={[
          { title: '名字', dataIndex: 'name' },
          {
            title: '状态',
            width: 120,
            render: (_: unknown, category: PatternCategory) =>
              category.enabled ? <Tag color="green">启用</Tag> : <Tag color="grey">已停用</Tag>,
          },
          {
            title: '图纸',
            width: 100,
            render: (_: unknown, category: PatternCategory) => `${counts.get(category.id) ?? 0} 张`,
          },
          {
            title: '操作',
            width: 330,
            render: (_: unknown, category: PatternCategory, index: number) => (
              <span className="toolbar" style={{ margin: 0, gap: 4 }}>
                <Button
                  size="small"
                  theme="borderless"
                  icon={<IconArrowUp />}
                  aria-label={`${category.name} 上移`}
                  disabled={busy || index === 0}
                  onClick={() => order.mutate(moveId(ids, category.id, -1))}
                />
                <Button
                  size="small"
                  theme="borderless"
                  icon={<IconArrowDown />}
                  aria-label={`${category.name} 下移`}
                  disabled={busy || index === ids.length - 1}
                  onClick={() => order.mutate(moveId(ids, category.id, 1))}
                />
                <Button size="small" disabled={busy} onClick={() => setEditing(category)}>
                  改名
                </Button>
                <Button size="small" disabled={busy} onClick={() => toggle.mutate(category)}>
                  {category.enabled ? '停用' : '启用'}
                </Button>
                {counts.get(category.id) ? null : (
                  <Button
                    size="small"
                    type="danger"
                    theme="borderless"
                    disabled={busy}
                    onClick={() => void confirmRemove(category)}
                  >
                    删除
                  </Button>
                )}
              </span>
            ),
          },
        ]}
      />
      <Typography.Paragraph type="tertiary" size="small" style={{ marginTop: 8 }}>
        停用的分类顾客看不到，里面的图纸仍在「全部」里。没有图纸（含下架的）的分类才能删除，有图纸的先把图纸改到别的分类。
      </Typography.Paragraph>
      {editing ? (
        <CategoryDialog
          library={library}
          category={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </Card>
  )
}

function CategoryDialog({
  library,
  category,
  onClose,
}: {
  library: PatternLibrary
  category: PatternCategory | null
  onClose: () => void
}) {
  const [name, setName] = useState(category?.name ?? '')
  const [touched, setTouched] = useState(false)
  const taken = library.categories.filter((item) => item.id !== category?.id).map((item) => item.name)
  const problem = categoryNameProblem(name, taken)
  const unchanged = category !== null && name.trim() === category.name
  const save = useLibraryMutation(
    (value: string) =>
      category ? storefrontApi.updateCategory(category.id, { name: value }) : storefrontApi.addCategory(value),
    category ? '分类已改名' : '分类已添加',
  )
  const submit = () => {
    setTouched(true)
    if (problem || unchanged) return
    save.mutate(name.trim(), { onSuccess: onClose })
  }
  return (
    <Modal
      title={category ? `给分类「${category.name}」改名` : '添加图纸分类'}
      visible
      maskClosable={false}
      width={440}
      onCancel={onClose}
      okText={category ? '保存' : '添加'}
      onOk={submit}
      {...dialogButtons}
      okButtonProps={{ ...dialogButtons.okButtonProps, disabled: unchanged, loading: save.isPending }}
    >
      <Field
        label="分类名字"
        required
        help={`最多 ${maxCategoryName} 个字，不能和已有的重名。${category ? '' : '新分类排在最后。'}`}
        errors={touched && problem ? [problem] : []}
      >
        {(control) => (
          <Input
            {...control}
            placeholder="如 节日"
            maxLength={20}
            disabled={save.isPending}
            value={name}
            onChange={setName}
            onBlur={() => setTouched(true)}
            onEnterPress={submit}
          />
        )}
      </Field>
    </Modal>
  )
}
