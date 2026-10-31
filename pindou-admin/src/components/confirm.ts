import { Modal } from '@douyinfe/semi-ui'
import type { ReactNode } from 'react'

type ModalOptions = Parameters<typeof Modal.confirm>[0]

/**
 * 弹窗底部按钮的读屏名就用按钮上的字。Semi 的 Modal 给两个按钮写死了英文 aria-label（confirm、cancel），
 * 盖过按钮上的中文；这里把它去掉（设成 undefined），名字回到可见文字。用在自己写的 <Modal> 上：
 * `<Modal {...dialogButtons} okButtonProps={{ ...dialogButtons.okButtonProps, disabled }} />`。
 */
export const dialogButtons = {
  okButtonProps: { 'aria-label': undefined },
  cancelButtonProps: { 'aria-label': undefined },
} satisfies Pick<ModalOptions, 'okButtonProps' | 'cancelButtonProps'>

export interface ConfirmOptions {
  title: ReactNode
  content: ReactNode
  /** 确认按钮上的字，写清做什么（「放弃并离开」「确认收款」），不写「确定」。 */
  okText: string
  cancelText?: string
  /** danger：会丢掉输入、不能撤回的操作，确认按钮用危险样式。 */
  okType?: 'primary' | 'danger'
  okDisabled?: boolean
  /** confirm（默认）问一句；warning 带警示图标；info 只是告知（通常 hasCancel: false）。 */
  variant?: 'confirm' | 'warning' | 'info'
  hasCancel?: boolean
  width?: number
}

/**
 * 确认框：Semi 的 Modal.confirm 加两件事——按钮读屏名用可见文字，会丢输入的确认标成危险样式。
 * 点确认返回 true，取消、关掉返回 false；之后要做什么由调用方决定（不把会失败的 Promise 交给 Semi：
 * 它会在弹窗上转圈，失败时再抛成没人接的 rejection）。
 */
export function confirmDialog({
  title,
  content,
  okText,
  cancelText = '取消',
  okType = 'primary',
  okDisabled = false,
  variant = 'confirm',
  hasCancel = true,
  width,
}: ConfirmOptions): Promise<boolean> {
  const open = variant === 'warning' ? Modal.warning : variant === 'info' ? Modal.info : Modal.confirm
  return new Promise((resolve) => {
    open({
      title,
      content,
      okText,
      cancelText,
      okType,
      hasCancel,
      ...(width ? { width } : {}),
      okButtonProps: { ...dialogButtons.okButtonProps, disabled: okDisabled },
      cancelButtonProps: dialogButtons.cancelButtonProps,
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    })
  })
}
