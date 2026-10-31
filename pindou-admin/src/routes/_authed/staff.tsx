import { Banner, Button, Card, Radio, RadioGroup, Table, Tag, Toast, Typography } from '@douyinfe/semi-ui'
import { useForm } from '@tanstack/react-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { z } from 'zod'
import { hasRole, useCurrentAccount, type StaffRole } from '../../account'
import { staffApi, type ListedAccount, type RoleAssignment } from '../../api/staff'
import { Nowrap } from '../../components/Nowrap'
import { Page, QueryState } from '../../components/Page'
import { AccountPicker } from '../../features/staff/AccountPicker'
import { accountLabel, canRevoke, currentRoles, labelOrId, rolesOf } from '../../features/staff/roles'
import { dateTime } from '../../lib/format'
import { roleNames } from '../../session'
import { confirmDialog } from '../../components/confirm'

export const Route = createFileRoute('/_authed/staff')({
  component: StaffRolesPage,
})

const roleColors = { clerk: 'green', manager: 'blue', owner: 'amber' } as const

const assignSchema = z.object({
  accountId: z.string().min(1, '请选择账号'),
  role: z.enum(['clerk', 'manager', 'owner']),
})

function StaffRolesPage() {
  const me = useCurrentAccount()
  const isOwner = hasRole(me, 'owner')
  const queryClient = useQueryClient()
  // 下拉里选中的账号：确认弹窗照它写清对象（选项只是服务端按关键字筛出的一批，选中后换关键字也不丢）
  const [picked, setPicked] = useState<ListedAccount | null>(null)
  const assignments = useQuery({
    queryKey: ['staff-role-assignments'],
    queryFn: ({ signal }) => staffApi.listRoleAssignments(signal),
  })

  const assign = useMutation({
    mutationFn: ({ accountId, role }: z.infer<typeof assignSchema>) => staffApi.assignRole(accountId, role),
    onSuccess: () => {
      Toast.success('角色已更新')
      void queryClient.invalidateQueries()
    },
  })
  const revoke = useMutation({
    mutationFn: (assignment: RoleAssignment) => staffApi.revokeRole(assignment.id),
    onSuccess: () => {
      Toast.success('角色已撤销')
      void queryClient.invalidateQueries()
    },
  })

  const form = useForm({
    defaultValues: { accountId: '', role: 'clerk' as StaffRole },
    validators: { onSubmit: assignSchema },
    onSubmit: async ({ value, formApi }) => {
      const target = picked?.id === value.accountId ? picked : null
      if (!target) return
      const confirmed = await confirmDialog({
        title: '确认分配角色',
        content: (
          <div>
            <div>{accountLabel(target)}</div>
            <div>当前：{currentRoles(targetRoles(target))}</div>
            <div>变更为：{roleNames[value.role]}</div>
          </div>
        ),
        okText: '确认分配',
      })
      if (!confirmed) return
      await assign.mutateAsync(value)
      formApi.reset()
      setPicked(null)
    },
  })

  // 账号现有的角色以任命列表为准（实时更新）；列表还没读到时用搜索结果里带的
  const targetRoles = (account: ListedAccount) => ({
    roles: assignments.data ? rolesOf(assignments.data, account.id) : account.roles,
  })
  const roleChoices: StaffRole[] = isOwner ? ['clerk', 'manager', 'owner'] : ['clerk', 'manager']

  // 失败原因显示在列表上方（revoke.error），不把会失败的 Promise 交给确认框
  const confirmRevoke = (assignment: RoleAssignment) =>
    void confirmDialog({
      title: '撤销角色',
      content: `${labelOrId(assignment.account, assignment.accountId)}\n撤销：${roleNames[assignment.role]}`,
      okText: '确认撤销',
      okType: 'danger',
    }).then((ok) => {
      if (ok) revoke.mutate(assignment)
    })

  return (
    <Page
      title="员工权限"
      description="给已在小程序注册的账号分配店员、店长或老板。一个账号同时只有一个员工角色；店长不能管理老板，系统至少保留一位老板。"
    >
      <div className="card-grid">
        <Card title="分配角色">
          {assign.isError ? (
            <Banner type="danger" closeIcon={null} description={assign.error.message} style={{ marginBottom: 12 }} />
          ) : null}
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void form.handleSubmit()
            }}
          >
            <form.Field name="accountId">
              {(field) => (
                <div style={{ marginBottom: 16 }}>
                  <Typography.Text strong>员工账号</Typography.Text>
                  <AccountPicker
                    value={field.state.value && picked?.id === field.state.value ? picked : null}
                    onChange={(account) => {
                      setPicked(account)
                      field.handleChange(account?.id ?? '')
                    }}
                    isOwner={isOwner}
                    invalid={field.state.meta.errors.length > 0}
                  />
                  {field.state.value && picked ? (
                    <Typography.Text type="tertiary" size="small">
                      当前角色：{currentRoles(targetRoles(picked))}
                    </Typography.Text>
                  ) : null}
                  {field.state.meta.errors.length ? (
                    <Typography.Text type="danger" size="small">
                      {field.state.meta.errors.map((error) => error?.message).join('；')}
                    </Typography.Text>
                  ) : null}
                </div>
              )}
            </form.Field>
            <form.Field name="role">
              {(field) => (
                <div style={{ marginBottom: 16 }}>
                  <Typography.Text strong>拟分配角色</Typography.Text>
                  <div style={{ marginTop: 8 }}>
                    <RadioGroup
                      type="button"
                      value={field.state.value}
                      onChange={(event) => field.handleChange(event.target.value as StaffRole)}
                    >
                      {roleChoices.map((role) => (
                        <Radio key={role} value={role}>
                          {roleNames[role]}
                        </Radio>
                      ))}
                    </RadioGroup>
                  </div>
                </div>
              )}
            </form.Field>
            <form.Subscribe selector={(state) => state.isSubmitting}>
              {(submitting) => (
                <Button htmlType="submit" theme="solid" type="primary" loading={submitting || assign.isPending}>
                  确认分配
                </Button>
              )}
            </form.Subscribe>
          </form>
        </Card>
        <Card title="当前角色">
          {revoke.isError ? (
            <Banner type="danger" closeIcon={null} description={revoke.error.message} style={{ marginBottom: 12 }} />
          ) : null}
          <QueryState query={assignments}>
            {(rows) => (
              <Table
                size="small"
                rowKey="id"
                dataSource={rows}
                pagination={rows.length > 10 ? { pageSize: 10 } : false}
                empty="暂无员工角色"
                columns={[
                  {
                    title: '员工',
                    render: (_: unknown, row: RoleAssignment) => labelOrId(row.account, row.accountId),
                  },
                  {
                    title: '角色',
                    dataIndex: 'role',
                    render: (role: StaffRole) => <Tag color={roleColors[role]}>{roleNames[role]}</Tag>,
                  },
                  {
                    title: '任命时间',
                    dataIndex: 'assignedAt',
                    render: (value: string) => <Nowrap>{dateTime(value)}</Nowrap>,
                  },
                  {
                    title: '',
                    render: (_: unknown, row: RoleAssignment) => {
                      if (row.accountId === me.id) return <Typography.Text type="tertiary">本人</Typography.Text>
                      return canRevoke(row, { id: me.id, isOwner }, rolesOf(rows, row.accountId)) ? (
                        <Button type="danger" theme="borderless" size="small" onClick={() => confirmRevoke(row)}>
                          撤销
                        </Button>
                      ) : null
                    },
                  },
                ]}
              />
            )}
          </QueryState>
        </Card>
      </div>
    </Page>
  )
}
