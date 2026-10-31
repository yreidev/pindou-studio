import { Button as TaroButton, type ButtonProps } from '@tarojs/components'

export function Button({ className = '', hoverClass = 'pressed', children, ...props }: ButtonProps) {
  const selected = /(?:^|\s)(?:selected|\S+-(?:selected|current))(?:\s|$)/.test(className)
  const label =
    props.ariaLabel ||
    (typeof children === 'string'
      ? `${children}${selected ? '，已选中' : ''}${props.disabled ? '，暂不可用' : ''}`
      : undefined)
  return (
    <TaroButton
      {...props}
      ariaLabel={label}
      className={`ui-button ${className}`}
      hoverClass={props.disabled ? 'none' : hoverClass}
    >
      {children}
    </TaroButton>
  )
}
