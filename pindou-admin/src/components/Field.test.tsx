import { CheckboxGroup, Input, Radio, RadioGroup } from '@douyinfe/semi-ui'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { errorMessages, Field } from './Field'
import { NamedSelect } from './NamedSelect'

// 字段外壳：标题、说明、错误都要接到控件上，读屏聚焦控件时念得出名字、说明和错在哪。

describe('字段外壳', () => {
  it('普通输入框：标题是它的名字，说明是它的描述；必填标 aria-required，星号不念', () => {
    render(
      <Field label="退款原因" required help="记入审计，之后不能修改。">
        {(control) => <Input {...control} />}
      </Field>,
    )
    const input = screen.getByRole('textbox', { name: '退款原因', description: '记入审计，之后不能修改。' })
    expect(input.getAttribute('aria-required')).toBe('true')
    expect(input.hasAttribute('aria-invalid')).toBe(false)
  })

  it('出错：输入框标成填错，错误挂在描述和 aria-errormessage 上，同一句只说一次', () => {
    render(
      <Field label="减免金额（元）" help="直接减免的金额" errors={[{ message: '请填写金额' }, '请填写金额', undefined]}>
        {(control) => <Input {...control} />}
      </Field>,
    )
    const input = screen.getByRole('textbox', { name: '减免金额（元）', description: '直接减免的金额 请填写金额' })
    expect(input.getAttribute('aria-invalid')).toBe('true')
    const message = document.getElementById(input.getAttribute('aria-errormessage') ?? '')
    expect(message?.textContent).toBe('请填写金额')
    expect(errorMessages([{ message: '甲' }, '乙', { message: '甲' }])).toBe('甲；乙')
  })

  it('没有标题的一格（明细表）：名字用控件自己的 aria-label，错误照样挂上', () => {
    render(
      <Field compact errors={['单价须为非负金额']}>
        {(control) => <Input {...control} aria-label="第 1 项单价（元）" />}
      </Field>,
    )
    expect(
      screen
        .getByRole('textbox', { name: '第 1 项单价（元）', description: '单价须为非负金额' })
        .getAttribute('aria-invalid'),
    ).toBe('true')
  })

  it('单选组：外层这一组带名字和说明（Semi 单选组外层是不带角色的 div，自己的 aria-label 不算数）', () => {
    render(
      <Field label="线下收款方式" labelMode="radiogroup" help="核实到账后再确认。">
        {() => (
          <RadioGroup type="button" name="test-method" value="wechat">
            <Radio value="wechat">微信</Radio>
            <Radio value="cash">现金</Radio>
          </RadioGroup>
        )}
      </Field>,
    )
    const group = screen.getByRole('radiogroup', { name: '线下收款方式', description: '核实到账后再确认。' })
    expect(group.contains(screen.getByRole('radio', { name: '现金' }))).toBe(true)
  })

  it('多选组：标题经 aria-labelledby 接到 list 上（<label for> 指不到 div）', () => {
    render(
      <Field label="每周休息日" labelMode="labelledby" help="最多 6 天">
        {(control) => (
          <CheckboxGroup
            id={control.id}
            aria-labelledby={control['aria-labelledby']}
            aria-describedby={control['aria-describedby']}
            options={[{ label: '周一', value: 1 }]}
          />
        )}
      </Field>,
    )
    expect(screen.getByRole('list', { name: '每周休息日', description: '最多 6 天' })).toBeTruthy()
    expect(document.querySelector('label')).toBeNull()
  })

  it('一组控件（日期选择器加按钮）：组上带名字、说明和错误', () => {
    render(
      <Field label="歇业日期" labelMode="group" help="选一天点加入" errors={['歇业日期最多设 90 个']}>
        {() => <button type="button">加入歇业日</button>}
      </Field>,
    )
    const group = screen.getByRole('group', { name: '歇业日期', description: '选一天点加入 歇业日期最多设 90 个' })
    expect(group.contains(screen.getByRole('button', { name: '加入歇业日' }))).toBe(true)
  })
})

describe('有读屏名的下拉框', () => {
  const options = [
    { value: 'custom', label: '自定义服务（不扣库存）' },
    { value: 'bead', label: '拼豆材料包' },
  ]

  it('没选和选中后都念我们给的名字（Semi 自己写的 aria-label 是空的或英文 selected）', () => {
    const { rerender } = render(<NamedSelect label="添加商品" optionList={options} filter value={undefined} />)
    expect(screen.getByRole('combobox', { name: '添加商品' })).toBeTruthy()
    rerender(<NamedSelect label="第 1 项商品或服务" optionList={options} filter value="bead" />)
    expect(screen.getByRole('combobox', { name: '第 1 项商品或服务' })).toBeTruthy()
  })

  it('在字段外壳里：用可见标题作名字，说明和错误也接上', () => {
    render(
      <Field label="商品" labelMode="labelledby" required help="当前库存 3 件" errors={['请选择商品']}>
        {(control) => <NamedSelect {...control} label="盘点商品" optionList={options} />}
      </Field>,
    )
    const combobox = screen.getByRole('combobox', { name: '商品', description: '当前库存 3 件 请选择商品' })
    expect(combobox.getAttribute('aria-invalid')).toBe('true')
    expect(combobox.getAttribute('aria-required')).toBe('true')
  })
})
