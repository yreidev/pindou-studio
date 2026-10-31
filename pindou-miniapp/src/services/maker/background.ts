import { bucket, oklabTable } from './color'
import type { Pixels } from './image'

// 认背景色：四边像素里占得多的一两种颜色。导入像素画、图纸截图（importer.ts）时用它找出内容范围、认出空格子。
// 照片的「抠图」（自动去背景、手动擦掉补回）2026-10-21 先拿掉了：从四边漫过去的做法在真照片上基本用不了
// （和参照只重合 59%），以后要做换成模型抠主体，见 docs/plan-bead-maker.md 第 3 节 0。

/** 四边像素里的背景色（OKLab），占四边一成以上的最多两种。 */
export function borderColors(img: Pixels): number[][] {
  const table = oklabTable()
  const { width: w, height: h, data } = img
  const counts = new Map<number, number>()
  let total = 0
  const visit = (x: number, y: number) => {
    const i = (y * w + x) * 4
    if (data[i + 3] < 128) return
    // 粗一点分桶（每通道 4 位），同一片背景的轻微噪点算一种
    const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4)
    counts.set(key, (counts.get(key) ?? 0) + 1)
    total++
  }
  for (let x = 0; x < w; x++) {
    visit(x, 0)
    visit(x, h - 1)
  }
  for (let y = 1; y < h - 1; y++) {
    visit(0, y)
    visit(w - 1, y)
  }
  // 相邻的桶并起来数
  const merged: { key: number; n: number }[] = []
  for (const [key, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    const r = key >> 8,
      g = (key >> 4) & 15,
      b = key & 15
    const host = merged.find(
      (m) =>
        Math.abs((m.key >> 8) - r) <= 1 && Math.abs(((m.key >> 4) & 15) - g) <= 1 && Math.abs((m.key & 15) - b) <= 1,
    )
    if (host) host.n += n
    else merged.push({ key, n })
  }
  return merged
    .filter((m) => m.n >= total * 0.1)
    .slice(0, 2)
    .map((m) => {
      const t = bucket(((m.key >> 8) << 4) + 8, (((m.key >> 4) & 15) << 4) + 8, ((m.key & 15) << 4) + 8) * 3
      return [table[t], table[t + 1], table[t + 2]]
    })
}
