// OpenAI 兼容 LLM 客户端（支持 DeepSeek / OpenAI / 任意兼容网关）
import { config } from './config.js';

const MAX_RETRY = 2;

function stripCodeFence(text) {
  let t = text.trim();
  // 去掉 ```json ... ``` 包裹
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) return fence[1].trim();
  // 截取第一个 { 到最后一个 }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start !== -1 && end > start) return t.slice(start, end + 1);
  return t;
}

/**
 * 调用 chat completions。
 * @param {Array<{role:string,content:string}>} messages
 * @param {{json?:boolean, temperature?:number, maxTokens?:number}} opts
 * @returns {Promise<string>}
 */
export async function chat(messages, opts = {}) {
  const { json = false, temperature = 0.7, maxTokens = 4000 } = opts;
  if (!config.llm.apiKey && config.llm.requireKey) {
    throw new Error('未配置 LLM_API_KEY，请在 .env 或 设置页 中填写');
  }

  const body = {
    model: config.llm.model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };
  if (json) {
    body.response_format = { type: 'json_object' };
  }

  const headers = { 'Content-Type': 'application/json' };
  if (config.llm.apiKey) headers.Authorization = `Bearer ${config.llm.apiKey}`;

  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    try {
      const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error('LLM 返回空内容');
      return json ? stripCodeFence(content) : content;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRY) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

/** 请求 JSON 结构结果，并做基础校验 */
export async function chatJson(messages, schema, opts = {}) {
  const raw = await chat(
    [...messages, { role: 'user', content: `\n\n请严格输出符合要求的 JSON 对象，不要输出任何多余文字。` }],
    { ...opts, json: true }
  );
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    obj = JSON.parse(stripCodeFence(raw));
  }
  if (!obj || typeof obj !== 'object') throw new Error('LLM 返回的不是 JSON 对象');
  if (schema) {
    for (const [key, type] of Object.entries(schema)) {
      if (obj[key] === undefined) obj[key] = type === 'array' ? [] : type === 'number' ? 0 : '';
    }
  }
  return obj;
}
