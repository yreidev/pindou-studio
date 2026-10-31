import type { AuditEvent } from '../../api/operations'
import { labelOrId } from '../staff/roles'

/**
 * 审计操作的中文名。来自后端 internal/app 里全部 s.audit(...) 调用；会员（loyalty.*）和预约
 * （reservation.*）按动作名拼接，这里逐个列出。layout.area.*、layout.table.created/split 现在
 * 已没有入口（布局固定），保留是为了旧记录还能看懂。没登记的动作照原样显示。
 */
export const auditNames: Record<string, string> = {
  'role.bootstrap-owner': '初始化老板',
  'role.assigned': '分配员工角色',
  'role.revoked': '撤销员工角色',
  'layout.area.created': '创建区域',
  'layout.area.updated': '调整区域',
  'layout.table.created': '创建桌位',
  'layout.table.updated': '调整桌位（启用/停用）',
  'layout.table.split': '拆分桌位',
  'order.lines.updated': '修改订单明细',
  'order.lines.repriced': '改计时后草稿自动改价',
  'order.voided': '撤销开台，作废草稿订单',
  'order.customer.changed': '更换订单顾客',
  'order.discount.created': '登记人工折扣',
  'order.paid': '确认收款',
  // 分笔付款（多人合付）收了一笔、还没收齐；收齐的那一笔记 order.paid
  'order.payment.partial': '分笔收款',
  'order.comped': '免单结清',
  'order.refunded': '登记退款',
  'stock.purchase.created': '采购入库',
  'stock.adjusted': '库存盘点调整',
  'stock.alert_updated': '修改库存预警线',
  'catalog.updated': '更新商品资料',
  // 应用内备份与恢复已退役（改用数据库备份），历史审计里还有这两种动作
  'backup.created': '创建备份',
  'backup.restored': '恢复备份',
  'data.exported': '导出全部数据',
  'venue_session.cancelled': '取消计时',
  'venue_session.timing_changed': '修改计时（开始时间、时长）',
  // 整桌开台的停止计时，以及分笔付款收第一笔时计时停住（按座会话也会）
  'venue_session.stopped': '停止计时（整桌开台、分笔收第一笔）',
  // 系统内收费关着时点「结束」：结束计时、放座，没收款的草稿订单一并作废（按座会话另记一条 loyalty.end）
  'venue_session.ended': '结束并放座',
  // 原因前面带「开 → 关：」
  'billing.toggled': '开关系统内收费',
  'developer.mode_switched': '切换体验身份',
  'web_login.approved': '批准电脑登录',
  'web_login.rejected': '拒绝电脑登录',
  'web_sessions.revoked': '退出全部电脑登录',
  // 桌码与网页后台登录码指向的小程序版本，原因前面带「原版本 → 新版本：」
  'miniprogram.env_changed': '修改小程序码指向的版本',
  // 顾客网页（2026-10-31 下线）留下的记录
  'account.registered_h5': '顾客网页注册',
  'password.changed': '修改网页密码',
  // 发认领用的临时密码（顾客网页下线前叫「重置网页密码」，同一个动作）
  'password.reset': '发临时密码',
  'service_call.handled': '处理呼叫店员',
  'service_call.claimed': '认领呼叫店员（我去处理）',
  'member_code.scanned': '扫会员码查顾客',
  'account.opened_member': '店员代开会员',
  'account.claimed_member': '顾客认领会员',
  // 首页内容（迁移 025）：图纸与分类，原因里写名字和改了什么；公告原因是公告文字
  'pattern.created': '上传图纸',
  'pattern.updated': '修改图纸',
  'pattern.deleted': '删除图纸',
  'pattern.reordered': '调整图纸顺序',
  'pattern_category.created': '添加图纸分类',
  'pattern_category.updated': '修改图纸分类',
  'pattern_category.deleted': '删除图纸分类',
  'pattern_category.reordered': '调整图纸分类顺序',
  'announcement.saved': '发布首页公告',
  'announcement.cleared': '清除首页公告',
  'bead_settings.saved': '修改做图纸用的豆子',
  'loyalty.save_rule': '保存规则草稿',
  'loyalty.publish': '发布规则',
  'loyalty.disable': '停用规则',
  'loyalty.birthday': '登记生日',
  'loyalty.claim': '领取会员福利',
  'loyalty.recharge': '会员充值',
  'loyalty.consume': '会员消费登记',
  'loyalty.consume_reverse': '撤销会员消费',
  'loyalty.adjust': '会员资产调整',
  'loyalty.recharge_refund': '充值退款',
  'loyalty.exchange': '积分兑换',
  'loyalty.fulfill_gift': '生日礼物核销',
  'loyalty.request': '扫码入座申请',
  'loyalty.cancel_request': '取消入座申请',
  'loyalty.confirm': '确认入座开台',
  'loyalty.reject': '拒绝入座申请',
  'loyalty.pause': '暂停计时',
  'loyalty.resume': '继续计时',
  'loyalty.stop': '停止计时',
  'loyalty.renew': '续时',
  'loyalty.move': '换座',
  'loyalty.end': '结束按座计时',
  'loyalty.checkout': '会员结账',
  'loyalty.refund': '会员消费退款',
  'reservation.book': '顾客预约',
  'reservation.register': '代客登记预约',
  'reservation.confirm': '确认预约',
  'reservation.cancel': '取消预约',
  'reservation.no_show': '标记爽约',
  'reservation.seat': '预约到店开台',
  'reservation.acknowledge': '知道了顾客取消预约',
  'reservation.save_settings': '保存营业与预约设置',
}

export function auditName(action: string): string {
  return auditNames[action] ?? action
}

/** 中文动作名含关键字的动作代码：审计在服务端筛选，中文名只有网页端知道，按名查找时把对上的代码一起发过去。 */
export function actionsMatching(keyword: string): string[] {
  const needle = keyword.trim().toLowerCase()
  if (!needle) return []
  return Object.entries(auditNames)
    .filter(([, name]) => name.toLowerCase().includes(needle))
    .map(([action]) => action)
}

/** 操作人：系统动作显示「系统」，其余用服务端带的称呼；账户不在了只显示编号前 8 位。 */
export function auditActor(event: Pick<AuditEvent, 'accountId' | 'actor'>): string {
  if (!event.accountId) return '—'
  if (event.accountId === 'system') return '系统'
  return labelOrId(event.actor, event.accountId)
}
