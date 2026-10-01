/**
 * 智能体 Agent 子项目构建脚本（可复现，改源码后 `npm run build`）
 *
 *   node build.mjs [--watch]
 *
 * 产物两块（都写进 public/llm-chat/vendor/，页面只引用这两个文件）：
 *   agent.js    —— React 界面 + core 逻辑（esbuild 打包为单文件 IIFE，含 React/Radix）
 *   agent.css   —— Tailwind 编译产物（含主题令牌与组件样式）
 *
 * 为什么打成单文件而不是 ESM 多模块：子项目约定「内部资源全部用相对路径引用、不依赖构建
 * 服务器」（见 server.js 的子项目自包含约定），单文件最省事、也不会在 /llm-chat/ 子路径下
 * 出现模块解析问题。core 层的模块化在**源码**里保证（src/core 一行不改即可 Node 单测）。
 */
import { build, context } from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(here, '../public/llm-chat/vendor');
const SRC = path.join(here, 'src');

const watch = process.argv.includes('--watch');

fs.mkdirSync(OUT_DIR, { recursive: true });

/** Tailwind v4 CLI：@import "tailwindcss" 由它的编译器解析（不能交给 esbuild） */
function buildCss() {
  const cli = path.join(here, 'node_modules/@tailwindcss/cli/dist/index.mjs');
  if (!fs.existsSync(cli)) throw new Error('缺少 @tailwindcss/cli，请先在 agent/ 下执行 npm install');
  const args = [cli, '-i', path.join(SRC, 'ui/styles.css'), '-o', path.join(OUT_DIR, 'agent.css')];
  if (!watch) args.push('--minify');
  execFileSync(process.execPath, args, { stdio: 'inherit', cwd: here });
}

/** 注入构建期常量：core 层用它判断"浏览器构建"，测试时为空 */
const define = { __AGENT_BUILD__: JSON.stringify(new Date().toISOString().slice(0, 19)) };

const options = {
  entryPoints: [path.join(SRC, 'ui/main.jsx')],
  outfile: path.join(OUT_DIR, 'agent.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome110', 'firefox110', 'safari16'],
  jsx: 'automatic',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  legalComments: 'none',
  define,
  logLevel: 'info',
  // React 生产构建：去掉开发期的双渲染与警告（体积也小一半）
  ...(watch ? {} : { drop: ['debugger'] }),
};

buildCss();

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('  👀 监听中（CSS 改动需重跑一次 npm run build）');
} else {
  const r = await build(Object.assign({ metafile: true }, options));
  const bytes = Object.values(r.metafile.outputs)[0].bytes;
  console.log(`\n  ✅ 构建完成：public/llm-chat/vendor/agent.js（${(bytes / 1024).toFixed(0)} KB）、agent.css`);
}
