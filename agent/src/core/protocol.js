/* protocol/index.js —— 协议注册表 + 服务商模板（新增一家 = 在这里加一行）
 *
 *  只有两条标准协议：openai（含一切兼容实现，本地模型同样走这条）与 anthropic。
 *  "彻底切换"的意思就是：不再有 Ollama 原生协议分支——本地模型只要实现 OpenAI 兼容接口，
 *  走的就是同一个适配器、同一套参数、同一套错误提示。
 */
import { openai } from './protocol/openai.js';
import { anthropic } from './protocol/anthropic.js';

export const PROTOCOLS = { openai, anthropic };
export const PROTOCOL_LIST = [openai, anthropic];
export const getProtocol = (id) => PROTOCOLS[id] || openai;

/** 服务商模板（"快速添加"用）：都是公网服务商。
 *  注：**不再有"本机模型"模板** —— 出口只允许公网（见 lib/upstream-http.js 的地址策略），
 *  服务端代转不会连内网，所以填本机地址会在请求时被明确拒绝。 */
export const TEMPLATES = [
  { key: 'opencode', name: 'opencode Go', type: 'openai', baseUrl: 'https://opencode.ai/zen/go/v1', model: 'deepseek-v4.1-flash', note: 'opencode 的 Go 套餐网关。它要求客户端为每段对话带会话标识头 x-opencode-session，程序按地址认出来会自动带上，不用手填' },
  { key: 'deepseek', name: 'DeepSeek', type: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { key: 'siliconflow', name: '硅基流动', type: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen3-235B-A22B-Instruct-2507' },
  { key: 'dashscope', name: '阿里云通义千问', type: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { key: 'moonshot', name: 'Moonshot Kimi', type: 'openai', baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k2-0905-preview' },
  { key: 'zhipu', name: '智谱 GLM', type: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.6' },
  { key: 'openrouter', name: 'OpenRouter', type: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-4.5' },
  { key: 'openai', name: 'OpenAI 官方', type: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
  { key: 'anthropic', name: 'Anthropic Claude', type: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5' },
  { key: 'custom', name: '自定义…', type: 'openai', baseUrl: '', model: '' },
];

export { openai, anthropic };
