import { useSyncExternalStore } from 'react'
import { customer } from '../services/platform'
import { CustomerError } from '../services/customer'

export function useCustomer() {
  return useSyncExternalStore(customer.subscribe, customer.getSnapshot, customer.getSnapshot)
}

export function isMissing(error: unknown) {
  return error instanceof CustomerError && (error.status === 403 || error.status === 404)
}
