import { AuthBoundary, Screen } from '../../../components/customer'
import { MyReservationsContent } from '../../../components/customer/my-reservations'

export default function MyReservations() {
  return (
    <Screen title="我的预约" back className="my-reservations-screen">
      <AuthBoundary>
        <MyReservationsContent />
      </AuthBoundary>
    </Screen>
  )
}
