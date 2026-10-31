import { expand } from './tree'

// components/sheet.tsx 的替身。真的外壳要渲染器传 Context、要量面板多高，测试里直接摊成遮罩、面板两层：
// 标题行和内容都在面板的 children 里，点遮罩、点关闭直接调 onClose（提交中点了不关；填了字点遮罩不关、点关闭照常关）。
// 升起、滑下、拖着关在真机验收。

type Tree = unknown
type Props = {
  mask: string
  panel: string
  label?: string
  head: Tree
  children?: Tree
  onClose: () => void
  locked?: boolean
  dirty?: boolean
}

function SheetFrame({ mask, panel, label, head, children, onClose, locked = false, dirty = false }: Props) {
  const close = () => {
    if (!locked) onClose()
  }
  const swap = (tree: Tree): Tree => {
    if (Array.isArray(tree)) return tree.map(swap)
    if (!tree || typeof tree !== 'object') return tree
    const node = tree as { type: unknown; props: Record<string, unknown> }
    if (node.type === 'SheetCloseButton') return { type: 'Button', props: { ...node.props, onClick: close } }
    if (node.props?.children === undefined) return node
    return { ...node, props: { ...node.props, children: swap(node.props.children) } }
  }
  return {
    type: 'View',
    props: {
      className: mask,
      onClick: () => {
        if (!dirty) close()
      },
      children: {
        type: 'View',
        props: { className: panel, role: 'dialog', ariaLabel: label, children: swap([head, children]) },
      },
    },
  }
}

export const sheetModule = { SheetFrame, SheetCloseButton: 'SheetCloseButton' }

/** 页面树里的弹层外壳就地摊开 */
export const expandSheets = (tree: Tree) => expand(tree, [SheetFrame])
