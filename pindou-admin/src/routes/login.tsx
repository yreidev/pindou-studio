import { Banner, Button, Card, Spin, Steps, Typography } from '@douyinfe/semi-ui'
import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { QRCodeSVG } from 'qrcode.react'
import { useEffect, useState } from 'react'
import { z } from 'zod'
import { claimWebSession, createWebLoginChallenge, getWebLoginCode, type WebLoginChallenge } from '../api/auth'
import logo from '../assets/examplebrand-black.png'
import { safeRedirect } from '../features/auth/redirect'
import { loadSession, saveSession } from '../session'

const searchSchema = z.object({ redirect: z.string().optional() })

export const Route = createFileRoute('/login')({
  validateSearch: searchSchema,
  beforeLoad: ({ search }) => {
    if (loadSession()) throw redirect({ to: safeRedirect(search.redirect) })
  },
  component: LoginPage,
})

function LoginPage() {
  const navigate = useNavigate()
  const search = Route.useSearch()
  const [challenge, setChallenge] = useState<WebLoginChallenge | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const create = useMutation({ mutationFn: createWebLoginChallenge, onSuccess: setChallenge })
  const { mutate: refresh } = create

  // 进页面就要一个挑战
  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const expired = challenge !== null && now >= new Date(challenge.expiresAt).getTime()

  // 每个挑战换一张小程序码（微信扫一扫直达批准页）；换不到就退回普通二维码，在小程序里用「扫码」扫
  const code = useQuery({
    queryKey: ['web-login-code', challenge?.id],
    queryFn: () => getWebLoginCode(challenge as WebLoginChallenge),
    enabled: challenge !== null,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  })
  const miniProgramCode = code.data?.kind === 'image' ? code.data.dataUrl : null

  const claim = useQuery({
    queryKey: ['web-login', challenge?.id],
    queryFn: () => claimWebSession(challenge as WebLoginChallenge),
    enabled: challenge !== null && !expired,
    refetchInterval: (query) => (query.state.data?.kind === 'pending' ? 2000 : false),
    refetchOnWindowFocus: false,
    gcTime: 0,
    retry: 3,
  })

  useEffect(() => {
    if (code.data?.kind === 'closed') refresh()
  }, [code.data, refresh])

  useEffect(() => {
    const result = claim.data
    if (result?.kind === 'issued') {
      saveSession({ accessToken: result.accessToken, expiresAt: result.expiresAt, user: result.user })
      void navigate({ to: safeRedirect(search.redirect), replace: true })
    } else if (result?.kind === 'closed') {
      refresh()
    }
  }, [claim.data, navigate, refresh, search.redirect])

  // 二维码过期后自动换一张，不让人对着一张失效的码扫
  useEffect(() => {
    if (expired && !create.isPending) refresh()
  }, [expired, create.isPending, refresh])

  const secondsLeft = challenge ? Math.max(0, Math.ceil((new Date(challenge.expiresAt).getTime() - now) / 1000)) : 0

  return (
    <div className="login-page">
      <Card className="login-card" bodyStyle={{ padding: 32 }}>
        <div className="login-body">
          <img className="login-logo" src={logo} alt="Example 示例工坊" />
          <Typography.Title heading={4}>示例工坊后台</Typography.Title>
          <Typography.Text type="tertiary">员工专用 · 用微信扫码登录</Typography.Text>

          <div
            className="login-qr"
            data-qr-text={challenge?.qrText ?? ''}
            data-code={miniProgramCode ? 'mini-program' : 'qr'}
          >
            {!challenge || expired || code.isPending ? (
              <Spin size="large" />
            ) : miniProgramCode ? (
              <img src={miniProgramCode} width={208} height={208} alt="登录小程序码：用微信扫一扫" />
            ) : (
              <QRCodeSVG value={challenge.qrText} size={208} marginSize={2} />
            )}
          </div>

          {create.isError ? (
            <Banner type="danger" closeIcon={null} description={create.error.message} />
          ) : claim.isError ? (
            <Banner type="warning" closeIcon={null} description="网络不稳定，正在重试…" />
          ) : (
            <Typography.Text type="tertiary">
              {challenge ? `登录码 ${secondsLeft} 秒后自动更新` : '正在生成登录码…'}
            </Typography.Text>
          )}

          {/* 步骤标题是单行、超出会被截断：标题只放几个字，完整说明放会换行的描述里（手机上也要看得全） */}
          {miniProgramCode ? (
            <Steps className="login-steps" type="basic" direction="vertical" size="small" current={-1}>
              <Steps.Step title="微信扫一扫" description="用手机微信「扫一扫」扫上面的小程序码" />
              <Steps.Step title="允许登录" description="小程序会打开「连电脑」，核对是这台电脑后点「允许登录」" />
            </Steps>
          ) : (
            <Steps className="login-steps" type="basic" direction="vertical" size="small" current={-1}>
              <Steps.Step title="打开小程序" description="手机打开「Example示例工坊」小程序，进入员工端的「现场」" />
              <Steps.Step title="扫码" description="点「连电脑」里的「扫登录码」，扫上面的二维码" />
              <Steps.Step title="允许登录" description="核对是这台电脑后，点「允许登录」" />
            </Steps>
          )}

          <Button onClick={() => refresh()} loading={create.isPending} theme="borderless">
            换一个登录码
          </Button>
        </div>
      </Card>
    </div>
  )
}
