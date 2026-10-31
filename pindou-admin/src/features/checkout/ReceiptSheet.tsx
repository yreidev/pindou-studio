import logo from '../../assets/examplebrand-black.png'
import type { Paper, Receipt, ReceiptRow } from './receipt'
import './receipt.css'

function Row({ row, strong }: { row: ReceiptRow; strong?: boolean }) {
  return (
    <div className={strong ? 'receipt-row receipt-strong' : 'receipt-row'}>
      <span>{row.label}</span>
      <span>{row.value}</span>
    </div>
  )
}

const Rule = () => <div className="receipt-rule" />

/**
 * 一张小票。屏幕上按选的纸宽预览，打印时只留它（见 receipt.css）。
 * 内容全部来自 receiptOf（订单接口的数字原样），会员余额是本单结账那一刻的。
 */
export function ReceiptSheet({ receipt, paper }: { receipt: Receipt; paper: Paper }) {
  return (
    <section className={`receipt-sheet receipt-${paper}`} data-paper={paper} aria-label="小票">
      <img className="receipt-logo" src={logo} alt="Example 示例工坊" />
      <div className="receipt-store">{receipt.store}</div>
      <div className="receipt-title">消费小票</div>
      <Rule />
      <Row row={{ label: '订单号', value: receipt.number }} />
      <Row row={receipt.time} />
      {receipt.customer ? <Row row={{ label: '顾客', value: receipt.customer }} /> : null}
      <Row row={{ label: '状态', value: receipt.status }} />
      <Rule />
      <div className="receipt-heading">消费明细</div>
      {receipt.lines.map((line, index) => (
        <Row key={index} row={{ label: line.name, value: line.detail }} />
      ))}
      {receipt.discounts.length ? (
        <>
          <Rule />
          <div className="receipt-heading">折扣与优惠</div>
          {receipt.discounts.map((row, index) => (
            <Row key={index} row={row} />
          ))}
        </>
      ) : null}
      <Rule />
      <Row row={{ label: '应收', value: receipt.receivable }} strong />
      {receipt.payments.map((row, index) => (
        <Row key={index} row={row} />
      ))}
      <Row row={{ label: '实收', value: receipt.paid }} strong />
      {receipt.refunds.map((row, index) => (
        <Row key={index} row={row} />
      ))}
      {receipt.member.length || receipt.balanceAfter.length ? (
        <>
          <Rule />
          <div className="receipt-heading">会员</div>
          {receipt.member.map((row) => (
            <Row key={row.label} row={row} />
          ))}
          {receipt.balanceAfter.length ? (
            <>
              <div className="receipt-note">本单结账后余额</div>
              {receipt.balanceAfter.map((row) => (
                <Row key={row.label} row={row} />
              ))}
            </>
          ) : null}
        </>
      ) : null}
      <Rule />
      <div className="receipt-footer">谢谢惠顾，欢迎再来</div>
    </section>
  )
}
