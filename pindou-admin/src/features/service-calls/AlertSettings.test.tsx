import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeNotificationApi } from '../../test/fake-notification'
import { defaultAlertPrefs, type AlertPrefs } from './alert-prefs'
import { AlertSettings } from './AlertSettings'

function mount(prefs: Partial<AlertPrefs> = {}) {
  vi.stubGlobal('Notification', fakeNotificationApi('granted').api)
  const onPrefsChange = vi.fn()
  const onTestSound = vi.fn()
  render(
    <AlertSettings
      visible
      onClose={() => {}}
      prefs={{ ...defaultAlertPrefs, ...prefs }}
      onPrefsChange={onPrefsChange}
      soundReady
      soundSupported
      onTestSound={onTestSound}
    />,
  )
  return { onPrefsChange, onTestSound }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('提醒设置：响铃时长与音量', () => {
  it('四档时长，默认一直响到有人处理；选了就改偏好', async () => {
    const { onPrefsChange } = mount()
    const options = screen.getAllByRole('radio')
    expect(options).toHaveLength(4)
    expect(screen.getByRole('radio', { name: '一直响到有人处理（最长 5 分钟）' })).toHaveProperty('checked', true)
    expect(screen.getByText('持续响时每 4 秒响一轮', { exact: false })).toBeTruthy()
    // 单选组设了自己的 name，不和页面上别的 Semi 单选组（默认都叫 default）串在一起
    for (const option of options) expect(option.getAttribute('name')).toBe('call-alert-ring-for')

    await userEvent.click(screen.getByRole('radio', { name: '响 30 秒' }))
    expect(onPrefsChange).toHaveBeenCalledWith({ ringFor: '30s' })
  })

  it('音量滑块显示当前音量，键盘调节按 5 一档改偏好；试听按现在的设置响', async () => {
    const { onPrefsChange, onTestSound } = mount({ volume: 60 })
    const slider = screen.getByRole('slider', { name: '音量' })
    expect(slider.getAttribute('aria-valuenow')).toBe('60')
    expect(slider.getAttribute('aria-valuemin')).toBe('0')
    expect(slider.getAttribute('aria-valuemax')).toBe('100')
    slider.focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(onPrefsChange).toHaveBeenCalledWith({ volume: 65 })

    await userEvent.click(screen.getByRole('button', { name: '试听' }))
    expect(onTestSound).toHaveBeenCalledTimes(1)
  })

  it('提示音关着时时长和音量不能改；音量为 0 时说明听不见', () => {
    mount({ sound: false })
    for (const option of screen.getAllByRole('radio')) expect(option).toHaveProperty('disabled', true)
    expect(screen.getByRole('slider', { name: '音量' }).getAttribute('aria-disabled')).toBe('true')
  })

  it('音量为 0：如实说响了也听不见', () => {
    mount({ volume: 0 })
    expect(screen.getByText('音量为 0，响了也听不见')).toBeTruthy()
  })
})
