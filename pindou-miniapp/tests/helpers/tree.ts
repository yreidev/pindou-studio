// 直接调用组件函数得到的 React 元素树：按条件找节点、取出显示的文字。
// 原生组件在替身里就是名字字符串（'View'、'Button'…），所以节点的 type 可以直接比。

export type Node = { type: any; props: Record<string, any> }

export function nodes(tree: unknown, predicate: (node: Node) => boolean): Node[] {
  if (Array.isArray(tree)) return tree.flatMap((child) => nodes(child, predicate))
  if (!tree || typeof tree !== 'object') return []
  const node = tree as Node
  return [...(predicate(node) ? [node] : []), ...nodes(node.props?.children, predicate)]
}

/** 节点里全部文字拼起来（按元素顺序，不含属性）。 */
export function label(tree: unknown): string {
  if (Array.isArray(tree)) return tree.map(label).join('')
  if (tree && typeof tree === 'object') return label((tree as Node).props?.children)
  return tree == null || typeof tree === 'boolean' ? '' : String(tree)
}

export const settle = () => new Promise((resolve) => setImmediate(resolve))

/**
 * 把树里这几个函数组件就地展开（调用它们得到子树），别的函数组件原样留着、不往里走。
 * 弹层外壳 StaffSheet 把按钮放在 footer 属性里，不展开的话 nodes 找不到底部按钮。
 */
export function expand(tree: unknown, components: unknown[]): unknown {
  if (Array.isArray(tree)) return tree.map((child) => expand(child, components))
  if (!tree || typeof tree !== 'object') return tree
  const node = tree as Node
  if (components.includes(node.type)) return expand(node.type(node.props), components)
  if (node.props?.children === undefined) return node
  return { ...node, props: { ...node.props, children: expand(node.props.children, components) } }
}

/** 同 expand，按函数组件的名字认：页面里没导出的组件（比如手作页的 TimingCard）用它。 */
export function expandNamed(tree: unknown, names: string[]): unknown {
  if (Array.isArray(tree)) return tree.map((child) => expandNamed(child, names))
  if (!tree || typeof tree !== 'object') return tree
  const node = tree as Node
  if (typeof node.type === 'function' && names.includes(node.type.name))
    return expandNamed(node.type(node.props), names)
  if (node.props?.children === undefined) return node
  return { ...node, props: { ...node.props, children: expandNamed(node.props.children, names) } }
}
