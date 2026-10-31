import Taro from '@tarojs/taro'
import { applyMask, CUT_SIDE, maskFrom, maskShare, modelInput, unpackModel } from './cutout'
import type { Pixels } from './image'

// 抠图里调微信接口的部分（试用，2026-10-22；纯函数在 cutout.ts）。
// 模型随做图纸分包发（pages/maker/model/u2netp.br，.br 在微信代码包的文件白名单里），第一次用时解开写进本地用户文件，以后直接用；
// 推理用微信自带的 wx.createInferenceSession（基础库 2.30.0 起，只认 .onnx，文件可以在本地用户目录）。
// 这个模型有几层是「大数相减」（BN 折进卷积后偏置上千，后一层靠它们相减），半精度会算坏，
// 所以 precisionLevel 用 4（fp32 存、fp32 算、不开近似数学），也不开 NPU（iOS 的 NPU 走半精度）。
// 推理会话占内存，抠完一张就销毁；同一张照片的结果由页面记着，不重复抠。

const PACKED = 'pages/maker/model/u2netp.br'
/** 解开后的模型文件名；换了模型改这里的编号，旧的会被删掉 */
const MODEL_FILE = 'maker-u2netp-1.onnx'
const LOAD_TIMEOUT = 60_000

export class CutoutError extends Error {}

export type CutoutResult = {
  pixels: Pixels
  /** 主体占整张的多少（0～1） */
  share: number
  /** 各步用了多少毫秒：解开模型（只有第一次）、加载模型、推理和套蒙版 */
  timing: { unpack: number; load: number; run: number }
}

const errText = (error: unknown) =>
  String((error as { errMsg?: string; message?: string })?.errMsg ?? (error as Error)?.message ?? error)

function readPacked(): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    // 这个接口不支持 Promise 写法（微信文档），只能用回调；Taro 的类型写着返回 Promise，所以标 void
    void Taro.getFileSystemManager().readCompressedFile({
      filePath: PACKED,
      compressionAlgorithm: 'br',
      success: (res) => resolve(res.data),
      fail: (error) => reject(new CutoutError(`读不出模型文件：${errText(error)}`)),
    })
  })
}

/** 模型在本地用户目录里的路径；还没有就从分包里解开写进去。返回解开用了多少毫秒（已经有了是 0）。 */
async function ensureModel(): Promise<{ path: string; unpack: number }> {
  const fs = Taro.getFileSystemManager()
  const dir = Taro.env.USER_DATA_PATH ?? ''
  const path = `${dir}/${MODEL_FILE}`
  try {
    fs.accessSync(path)
    return { path, unpack: 0 }
  } catch {
    /* 第一次用 */
  }
  const start = Date.now()
  const onnx = unpackModel(await readPacked())
  try {
    // 先写临时名再改名：写到一半被打断，下次不会拿到半个模型
    fs.writeFileSync(`${path}.part`, onnx)
    fs.renameSync(`${path}.part`, path)
  } catch (error) {
    throw new CutoutError(`模型写不进手机（要 5 MB 空间）：${errText(error)}`)
  }
  try {
    for (const file of fs.readdirSync(dir))
      if (file.startsWith('maker-u2netp-') && file !== MODEL_FILE) fs.unlinkSync(`${dir}/${file}`)
  } catch {
    /* 旧文件删不掉不影响这次 */
  }
  return { path, unpack: Date.now() - start }
}

function openSession(path: string): Promise<Taro.InferenceSession> {
  return new Promise((resolve, reject) => {
    let settled = false
    // Taro 的类型把 precisionLevel 拼成了 precesionLevel，微信认的是 precisionLevel：不按字面量传，免得类型检查拦下
    const option = { model: path, precisionLevel: 4, allowNPU: false, allowQuantize: false }
    const session = Taro.createInferenceSession(option)
    const finish = (error?: CutoutError) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!error) return resolve(session)
      try {
        session.destroy()
      } catch {
        /* 没建成的会话销毁不了也无妨 */
      }
      reject(error)
    }
    const timer = setTimeout(() => finish(new CutoutError('模型加载超时')), LOAD_TIMEOUT)
    session.onLoad(() => finish())
    session.onError((error) => finish(new CutoutError(`模型加载失败：${errText(error)}`)))
  })
}

/** 微信版本够不够用抠图（基础库 2.30.0 起才有端侧推理）。 */
export const cutoutSupported = () => typeof Taro.createInferenceSession === 'function'

/** 抠出照片里的主体：背景透明，主体照旧。onStage 报告走到哪一步（页面显示用）。 */
export async function cutout(src: Pixels, onStage?: (stage: string) => void): Promise<CutoutResult> {
  if (!cutoutSupported()) throw new CutoutError('微信版本太旧，用不了抠图，升级微信后再试')
  onStage?.('正在准备模型…')
  const { path, unpack } = await ensureModel()
  onStage?.('正在加载模型…')
  let start = Date.now()
  const session = await openSession(path)
  const load = Date.now() - start
  try {
    onStage?.('正在抠图…')
    start = Date.now()
    const input = modelInput(src)
    let output: Taro.InferenceSession.Tensors
    try {
      output = await session.run({
        image: { type: 'float32', data: input.buffer as ArrayBuffer, shape: [1, 3, CUT_SIDE, CUT_SIDE] },
      })
    } catch (error) {
      throw new CutoutError(`推理失败：${errText(error)}`)
    }
    // 文档里输出的键有时写成 output0，有时是模型里的名字（mask），两种都认
    const tensor = output.mask ?? Object.values(output)[0]
    const pred = tensor ? new Float32Array(tensor.data) : new Float32Array(0)
    if (pred.length !== CUT_SIDE * CUT_SIDE) throw new CutoutError(`模型输出的大小不对（${pred.length}）`)
    if (pred.some((v) => !Number.isFinite(v))) throw new CutoutError('模型算出来的数不对（NaN）')
    const mask = maskFrom(pred)
    const pixels = applyMask(src, mask)
    return { pixels, share: maskShare(mask), timing: { unpack, load, run: Date.now() - start } }
  } finally {
    try {
      session.destroy()
    } catch {
      /* 已经销毁了 */
    }
  }
}
