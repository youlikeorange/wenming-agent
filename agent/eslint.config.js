/** agent/ 的静态检查配置（ESLint 扁平配置）
 *
 *  为什么要显式开 no-undef：扁平配置默认不开它，而一次大范围重写漏掉一行 import 时，
 *  浏览器只在运行时报 ReferenceError —— 模块求值期抛出等于整页白屏，静态检查却全绿。
 *  （仓库根 editor/eslint.config.mjs 里记着同一条教训。）
 *
 *  跑法：cd agent && npm run lint
 */
import reactHooks from 'eslint-plugin-react-hooks';

const browserGlobals = {
  window: 'readonly', document: 'readonly', location: 'readonly', history: 'readonly',
  navigator: 'readonly', localStorage: 'readonly', sessionStorage: 'readonly',
  fetch: 'readonly', Headers: 'readonly', Response: 'readonly', Request: 'readonly', ReadableStream: 'readonly',
  AbortController: 'readonly', AbortSignal: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
  requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly', performance: 'readonly',
  console: 'readonly', matchMedia: 'readonly', ResizeObserver: 'readonly', MutationObserver: 'readonly',
  DOMException: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly',
  URL: 'readonly', URLSearchParams: 'readonly', Blob: 'readonly', File: 'readonly', FileReader: 'readonly',
  CustomEvent: 'readonly', Event: 'readonly', getComputedStyle: 'readonly',
  crypto: 'readonly', queueMicrotask: 'readonly', structuredClone: 'readonly',
  globalThis: 'readonly', process: 'readonly',
};

const shared = {
  languageOptions: {
    ecmaVersion: 2023,
    sourceType: 'module',
    globals: browserGlobals,
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
  rules: {
    'no-undef': 'error',
    'no-unused-vars': ['warn', { args: 'after-used', argsIgnorePattern: '^_' }],
    'no-shadow': 'warn',
    complexity: ['warn', 10],
    'max-depth': ['warn', 4],
    'max-lines-per-function': ['warn', { max: 80, skipBlankLines: true, skipComments: true }],
    'max-statements': ['warn', 40],
    'max-params': ['warn', 6],
    'no-else-return': 'warn',
    'no-lonely-if': 'warn',
    'prefer-const': 'warn',
    eqeqeq: ['warn', 'smart'],
  },
};

export default [
  { files: ['src/**/*.js', 'src/**/*.jsx'], ...shared },
  {
    files: ['src/ui/**/*.jsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: { 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'warn' },
  },
  { files: ['test/**/*.mjs', 'test/**/*.js'], ...shared },
  { ignores: ['node_modules/**', 'dist/**', '**/*.min.js'] },
];
