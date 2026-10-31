import assert from 'node:assert/strict'
import { test } from 'vitest'
import { load } from './helpers/load'

test('staff login destinations cannot render staff content without roles', async () => {
  let auth: any = { status: 'anonymous', account: null }
  const Status = () => null,
    AuthBoundary = () => null,
    Screen = () => null,
    Skeleton = () => null
  const { StaffBoundary } = await load('components/staff.tsx', {
    './customer': { Status, AuthBoundary, Screen, Skeleton },
    '../hooks/customer': { useCustomer: () => auth },
  })
  assert.equal(StaffBoundary({ children: 'private' }).type, AuthBoundary)
  auth = { status: 'authenticated', account: { roles: [] } }
  assert.equal(StaffBoundary({ children: 'private' }).type, Status)
  assert.equal(StaffBoundary({ children: 'private' }).props.kind, 'forbidden')
  for (const role of ['clerk', 'manager', 'owner']) {
    auth = { status: 'authenticated', account: { roles: [role] } }
    assert.equal(StaffBoundary({ children: 'private' }).props.children, 'private')
  }
})
