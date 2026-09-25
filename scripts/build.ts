/**
 * 构建脚本：tsc 编译 src/ → dist/，并给产物里的 ESM 入口补 .js 扩展名处理（NodeNext 已保证）。
 * 用法：node scripts/build.ts（需 tsx 或 Node 20+ 直接跑 TS；这里用 child_process 调 tsc 更稳）
 */
import { execFileSync } from 'node:child_process'
import { rm, access } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

console.log('▶ 清理 dist/')
await rm(path.join(root, 'dist'), { recursive: true, force: true })

console.log('▶ tsc 构建')
execFileSync(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json'], {
  stdio: 'inherit',
  cwd: root,
})

// 给入口文件加 shebang
const mainPath = path.join(root, 'dist', 'main.js')
try {
  await access(mainPath)
} catch {
  console.error('✗ 构建失败：dist/main.js 不存在')
  process.exit(1)
}

console.log('✓ 构建完成 → dist/')
