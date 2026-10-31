// 把构建产物复制进 Go 后端，由 go:embed 编进二进制（pindou-backend/internal/adminui）。
// 先清掉上一次复制的文件，只留占位说明 README.txt，避免旧的带哈希文件名的产物一直堆在里面。
import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = join(root, 'dist')
const target = join(root, '..', 'pindou-backend', 'internal', 'adminui', 'dist')

if (!existsSync(join(source, 'index.html'))) {
  console.error('pindou-admin/dist 没有 index.html，先运行 pnpm build')
  process.exit(1)
}
for (const name of readdirSync(target)) {
  if (name !== 'README.txt') rmSync(join(target, name), { recursive: true, force: true })
}
cpSync(source, target, { recursive: true })
console.log(`已复制网页后台产物到 ${target}`)
