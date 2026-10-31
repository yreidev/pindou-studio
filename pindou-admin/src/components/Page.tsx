import { Banner, Button, Empty, Spin, Typography } from '@douyinfe/semi-ui'
import type { UseQueryResult } from '@tanstack/react-query'
import type { ReactNode } from 'react'

/** 后台页面骨架：标题、说明、右上角操作，内容在下面。 */
export function Page({
  title,
  description,
  extra,
  children,
}: {
  title: string
  description?: ReactNode
  extra?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <Typography.Title heading={3} style={{ margin: 0 }}>
            {title}
          </Typography.Title>
          {description ? (
            <Typography.Paragraph type="tertiary" style={{ marginTop: 4 }}>
              {description}
            </Typography.Paragraph>
          ) : null}
        </div>
        {extra ? <div className="page-extra">{extra}</div> : null}
      </div>
      {children}
    </div>
  )
}

/**
 * 查询的加载、失败、无权限三种状态，成功时渲染内容。
 * 重读失败但已有旧数据时保留旧内容并提示（实时重读可能偶尔失败，不要整页清空）。
 */
export function QueryState<T>({ query, children }: { query: UseQueryResult<T>; children: (data: T) => ReactNode }) {
  if (query.isPending) {
    return (
      <div className="page-center">
        <Spin size="large" />
      </div>
    )
  }
  if (query.isError && query.data === undefined) {
    const error = query.error as { status?: number; message?: string }
    if (error.status === 403) {
      return (
        <Empty
          title="当前账号无权查看"
          description="这部分只对特定员工角色开放，需要的话请老板在「员工权限」里调整。"
        />
      )
    }
    return (
      <Banner
        type="danger"
        closeIcon={null}
        title="读取失败"
        description={
          <span>
            {error.message ?? '请稍后重试'}{' '}
            <Button size="small" theme="borderless" onClick={() => void query.refetch()}>
              重试
            </Button>
          </span>
        }
      />
    )
  }
  return (
    <>
      {query.isError ? (
        <Banner
          type="warning"
          closeIcon={null}
          description="刚才重新读取失败，下面是上一次读到的内容。"
          style={{ marginBottom: 12 }}
        />
      ) : null}
      {children(query.data as T)}
    </>
  )
}
