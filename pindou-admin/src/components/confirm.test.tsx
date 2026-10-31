import '@douyinfe/semi-ui/react19-adapter'
import { Modal } from '@douyinfe/semi-ui'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { confirmDialog } from './confirm'

// 确认框：按钮的读屏名就是按钮上的字（Semi 默认写死英文 confirm、cancel）；会丢输入的用危险样式。

afterEach(() => {
  Modal.destroyAll()
  document.body.innerHTML = ''
})

describe('确认框', () => {
  it('按钮用可见文字作名字；危险操作的确认按钮是危险样式；点确认得到 true', async () => {
    const answer = confirmDialog({
      title: '放弃未保存的输入？',
      content: '离开后不会保留。',
      okText: '放弃并离开',
      cancelText: '继续填写',
      okType: 'danger',
    })
    const ok = await screen.findByRole('button', { name: '放弃并离开' })
    expect(ok.getAttribute('aria-label')).toBeNull()
    expect(ok.className).toContain('semi-button-danger')
    expect(screen.getByRole('button', { name: '继续填写' }).getAttribute('aria-label')).toBeNull()
    expect(screen.queryByRole('button', { name: 'confirm' })).toBeNull()
    await userEvent.click(ok)
    await expect(answer).resolves.toBe(true)
  })

  it('取消得到 false；默认是普通样式，取消按钮写「取消」', async () => {
    const answer = confirmDialog({ title: '确认盘点调整', content: '提交后不能撤销。', okText: '确认调整' })
    const ok = await screen.findByRole('button', { name: '确认调整' })
    expect(ok.className).toContain('semi-button-primary')
    await userEvent.click(screen.getByRole('button', { name: '取消' }))
    await expect(answer).resolves.toBe(false)
  })

  it('确认按钮可以先禁用（例如套餐已停用不能开台）', async () => {
    void confirmDialog({ title: '到店开台', content: '套餐已停用', okText: '到店开台', okDisabled: true })
    expect((await screen.findByRole('button', { name: '到店开台' })).hasAttribute('disabled')).toBe(true)
  })
})
