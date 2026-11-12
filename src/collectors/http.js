// 采集器 HTTP 客户端：仅使用 Node 内置模块，支持 HTTP(S) 代理、超时、重试和重定向。
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 2;
const MAX_REDIRECTS = 5;

function normalizeHeaders(headers = {}) {
  const out = {};
  if (headers && typeof headers.forEach === 'function') {
    headers.forEach((value, key) => { out[String(key).toLowerCase()] = String(value); });
    return out;
  }
  for (const [key, value] of Object.entries(headers || {})) {
    out[String(key).toLowerCase()] = String(value);
  }
  return out;
}

function readNodeResponse(res, { maxBytes = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    res.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (maxBytes > 0 && size > maxBytes) {
        res.destroy(new Error(`响应体超过上限（${maxBytes} bytes）`));
        return;
      }
      chunks.push(buffer);
    });
    res.on('end', () => {
      const headers = normalizeHeaders(res.headers);
      try {
        const body = decodeBody(Buffer.concat(chunks), headers['content-encoding']);
        if (maxBytes > 0 && body.length > maxBytes) {
          reject(new Error(`响应体超过上限（${maxBytes} bytes）`));
          return;
        }
        resolve({ status: res.statusCode || 0, headers, text: body.toString('utf8') });
      } catch (error) {
        reject(error);
      }
    });
    res.on('error', reject);
  });
}

function abortableSignal(signal) {
  if (!signal) return null;
  if (signal.aborted) throw new Error('请求已取消');
  return signal;
}

function requestWithNode(client, options, timeoutMs, { signal, maxBytes } = {}) {
  return new Promise((resolve, reject) => {
    const activeSignal = abortableSignal(signal);
    const req = client.request(options, (res) => {
      readNodeResponse(res, { maxBytes }).then(resolve, reject);
    });
    const onAbort = () => req.destroy(new Error('请求已取消'));
    activeSignal?.addEventListener?.('abort', onAbort, { once: true });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求超时（${timeoutMs}ms）`)));
    req.once('error', (error) => {
      activeSignal?.removeEventListener?.('abort', onAbort);
      reject(error);
    });
    req.once('close', () => activeSignal?.removeEventListener?.('abort', onAbort));
    req.end(options.body ?? undefined);
  });
}

async function requestDirect(target, headers, timeoutMs, options = {}) {
  const client = target.protocol === 'https:' ? https : http;
  return requestWithNode(client, {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || undefined,
    method: options.method || 'GET',
    path: `${target.pathname || '/'}${target.search || ''}`,
    headers: {
      ...headers,
      host: target.host,
    },
  }, timeoutMs, options);
}

async function requestHttpProxy(target, proxy, headers, timeoutMs, options = {}) {
  const client = proxy.protocol === 'https:' ? https : http;
  return requestWithNode(client, {
    protocol: proxy.protocol,
    hostname: proxy.hostname,
    port: proxy.port || undefined,
    method: options.method || 'GET',
    path: target.href,
    headers: {
      ...headers,
      host: target.host,
    },
  }, timeoutMs, options);
}

function openProxyTunnel(target, proxy, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proxyClient = proxy.protocol === 'https:' ? https : http;
    const connectReq = proxyClient.request({
      protocol: proxy.protocol,
      hostname: proxy.hostname,
      port: proxy.port || undefined,
      method: 'CONNECT',
      path: `${target.hostname}:${target.port || 443}`,
      headers: {
        host: `${target.hostname}:${target.port || 443}`,
      },
    });
    connectReq.setTimeout(timeoutMs, () => connectReq.destroy(new Error(`代理连接超时（${timeoutMs}ms）`)));
    connectReq.once('error', reject);
    connectReq.once('connect', (connectRes, socket, head) => {
      if ((connectRes.statusCode || 0) < 200 || (connectRes.statusCode || 0) >= 300) {
        socket.destroy();
        reject(new Error(`代理 CONNECT 失败（HTTP ${connectRes.statusCode || 0}）`));
        return;
      }
      if (head?.length) socket.unshift(head);
      resolve(socket);
    });
    connectReq.end();
  });
}

function requestHttpsThroughProxy(target, proxy, headers, timeoutMs, options = {}) {
  return openProxyTunnel(target, proxy, timeoutMs).then((socket) => new Promise((resolve, reject) => {
    const activeSignal = abortableSignal(options.signal);
    // 客户端自己完成 TLS 握手后再发请求：https.request 在传入现成 socket 时不会再次握手。
    // 不能传 agent:false —— 那会新建 Agent 并忽略 createConnection，退化成直连目标域名。
    let secure;
    try {
      // IP 字面量不能作为 SNI servername，否则 tls.connect 直接抛错。
      secure = tls.connect({ socket, servername: net.isIP(target.hostname) ? undefined : target.hostname });
    } catch (error) {
      socket.destroy();
      reject(error);
      return;
    }
    const fail = (error) => { secure.destroy(); socket.destroy(); reject(error); };
    secure.setTimeout(timeoutMs, () => fail(new Error(`TLS 握手超时（${timeoutMs}ms）`)));
    secure.once('error', fail);
    secure.once('secureConnect', () => {
      secure.setTimeout(0);
      const req = https.request({
        protocol: 'https:',
        hostname: target.hostname,
        port: target.port || 443,
        method: options.method || 'GET',
        path: `${target.pathname || '/'}${target.search || ''}`,
        createConnection: () => secure,
        headers: {
          ...headers,
          host: target.host,
        },
      }, (res) => {
        readNodeResponse(res, options).then(resolve, reject);
      });
      const onAbort = () => req.destroy(new Error('请求已取消'));
      activeSignal?.addEventListener?.('abort', onAbort, { once: true });
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求超时（${timeoutMs}ms）`)));
      req.once('error', (error) => { activeSignal?.removeEventListener?.('abort', onAbort); secure.destroy(); reject(error); });
      req.once('close', () => activeSignal?.removeEventListener?.('abort', onAbort));
      req.end(options.body ?? undefined);
    });
  }));
}

function decodeBody(buffer, encoding) {
  const value = String(encoding || '').toLowerCase();
  try {
    if (value.includes('br')) return zlib.brotliDecompressSync(buffer);
    if (value.includes('gzip')) return zlib.gunzipSync(buffer);
    if (value.includes('deflate')) return zlib.inflateSync(buffer);
    return buffer;
  } catch (error) {
    throw new Error(`响应解压失败（${value}）: ${error.message}`);
  }
}

/** HTTP/2 over CONNECT 隧道。部分站点（如 Cloudflare 保护的 linux.do）只对浏览器形态的 h2 请求放行。 */
function requestHttpsThroughProxyH2(target, proxy, headers, timeoutMs, options = {}) {
  return openProxyTunnel(target, proxy, timeoutMs).then((socket) => new Promise((resolve, reject) => {
    const activeSignal = abortableSignal(options.signal);
    let secure;
    try {
      secure = tls.connect({
        socket,
        servername: net.isIP(target.hostname) ? undefined : target.hostname,
        ALPNProtocols: ['h2', 'http/1.1'],
      });
    } catch (error) {
      socket.destroy();
      reject(error);
      return;
    }
    const fail = (error) => { secure.destroy(); socket.destroy(); reject(error); };
    secure.setTimeout(timeoutMs, () => fail(new Error(`TLS 握手超时（${timeoutMs}ms）`)));
    secure.once('error', fail);
    secure.once('secureConnect', () => {
      secure.setTimeout(0);
      if (secure.alpnProtocol !== 'h2') {
        secure.destroy();
        socket.destroy();
        // 目标不支持 h2，退回 HTTP/1.1
        requestHttpsThroughProxy(target, proxy, headers, timeoutMs, options).then(resolve, reject);
        return;
      }
      let session;
      try {
        session = http2.connect(`${target.protocol}//${target.host}`, { createConnection: () => secure });
      } catch (error) {
        fail(error);
        return;
      }
      let settled = false;
      let timer;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        activeSignal?.removeEventListener?.('abort', onAbort);
        session.close();
        fn(value);
      };
      const onAbort = () => finish(reject, new Error('请求已取消'));
      activeSignal?.addEventListener?.('abort', onAbort, { once: true });
      timer = setTimeout(() => finish(reject, new Error(`请求超时（${timeoutMs}ms）`)), timeoutMs);
      session.once('error', (error) => finish(reject, error));
      session.once('close', () => { if (!settled) finish(reject, new Error('HTTP/2 连接已关闭')); });
      const requestHeaders = {
        ':method': options.method || 'GET',
        ':path': `${target.pathname || '/'}${target.search || ''}`,
        ':authority': target.host,
        ':scheme': 'https',
      };
      for (const [key, value] of Object.entries(headers || {})) {
        const name = String(key).toLowerCase();
        if (name === 'host' || name === 'connection' || name === 'upgrade') continue;
        requestHeaders[name] = String(value);
      }
      let req;
      try {
        req = session.request(requestHeaders);
      } catch (error) {
        finish(reject, error);
        return;
      }
      let status = 0;
      const responseHeaders = {};
      const chunks = [];
      let size = 0;
      const maxBytes = Number(options.maxBytes) || 0;
      req.on('response', (incoming) => {
        status = Number(incoming[':status']) || 0;
        for (const [key, value] of Object.entries(incoming)) {
          if (key.startsWith(':')) continue;
          responseHeaders[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
        }
      });
      req.on('data', (chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (maxBytes > 0 && size > maxBytes) {
          finish(reject, new Error(`响应体超过上限（${maxBytes} bytes）`));
          return;
        }
        chunks.push(buffer);
      });
      req.on('end', () => {
        try {
          const body = decodeBody(Buffer.concat(chunks), responseHeaders['content-encoding']);
          if (maxBytes > 0 && body.length > maxBytes) {
            finish(reject, new Error(`响应体超过上限（${maxBytes} bytes）`));
            return;
          }
          finish(resolve, { status, headers: responseHeaders, text: body.toString('utf8') });
        } catch (error) {
          finish(reject, error);
        }
      });
      req.once('error', (error) => finish(reject, error));
      req.end(options.body ?? undefined);
    });
  }));
}

function parseProxy(proxyUrl) {
  if (!proxyUrl) return null;
  try {
    const parsed = new URL(proxyUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function requestOnce(url, options) {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol)) {
    throw new Error(`不支持的采集协议: ${target.protocol}`);
  }
  if (options.signal?.aborted) throw new Error('请求已取消');

  if (options.fetchImpl) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`请求超时（${options.timeoutMs}ms）`)), options.timeoutMs);
    const onAbort = () => controller.abort(new Error('请求已取消'));
    options.signal?.addEventListener?.('abort', onAbort, { once: true });
    try {
      const response = await options.fetchImpl(target.href, {
        method: options.method || 'GET',
        headers: options.headers,
        body: options.body ?? undefined,
        signal: controller.signal,
      });
      const text = await response.text();
      if (options.maxBytes > 0 && Buffer.byteLength(text, 'utf8') > options.maxBytes) {
        throw new Error(`响应体超过上限（${options.maxBytes} bytes）`);
      }
      return {
        status: response.status,
        headers: normalizeHeaders(response.headers),
        text,
      };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener?.('abort', onAbort);
    }
  }

  const proxy = parseProxy(options.proxy);
  if (!proxy) return requestDirect(target, options.headers, options.timeoutMs, options);
  if (target.protocol === 'https:') {
    if (options.http2) return requestHttpsThroughProxyH2(target, proxy, options.headers, options.timeoutMs, options);
    return requestHttpsThroughProxy(target, proxy, options.headers, options.timeoutMs, options);
  }
  return requestHttpProxy(target, proxy, options.headers, options.timeoutMs, options);
}

const SENSITIVE_REDIRECT_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization']);

async function requestWithRedirects(url, options, redirects = 0) {
  const response = await requestOnce(url, options);
  const location = response.headers.location;
  if ([301, 302, 303, 307, 308].includes(response.status) && location) {
    if (redirects >= MAX_REDIRECTS) throw new Error('重定向次数过多');
    const nextUrl = new URL(location, url).href;
    let nextOptions = options;
    const method = String(options.method || 'GET').toUpperCase();
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method !== 'GET')) {
      const headers = { ...(options.headers || {}) };
      delete headers['content-type'];
      delete headers['content-length'];
      nextOptions = { ...options, method: 'GET', body: null, headers };
    }
    // 跨 origin 重定向不转发认证/Cookie，避免凭据泄露给第三方。
    try {
      if (new URL(nextUrl).origin !== new URL(url).origin) {
        const headers = {};
        for (const [name, value] of Object.entries(nextOptions.headers || {})) {
          if (!SENSITIVE_REDIRECT_HEADERS.has(String(name).toLowerCase())) headers[name] = value;
        }
        nextOptions = { ...nextOptions, headers };
      }
    } catch {}
    return requestWithRedirects(nextUrl, nextOptions, redirects + 1);
  }
  return response;
}

/**
 * 获取文本响应。返回 status、规范化 headers 和 text，调用方负责解析正文。
 * throwOnHttpError=false 时由调用方（ctx.fetch）自己处理状态码和重试。
 */
export async function fetchText(url, {
  fetchImpl,
  proxy = '',
  headers = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retries = DEFAULT_RETRIES,
  http2 = false,
  signal,
  maxBytes = 0,
  throwOnHttpError = true,
  method = 'GET',
  body = null,
} = {}) {
  const requestOptions = {
    fetchImpl,
    proxy,
    http2,
    signal,
    method: String(method || 'GET').toUpperCase(),
    body,
    maxBytes: Number(maxBytes) || 0,
    timeoutMs: Math.max(1_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS),
    headers: {
      accept: 'application/rss+xml, application/atom+xml, application/json, text/xml, text/plain;q=0.9, */*;q=0.8',
      'user-agent': 'X-Monitor/1.2 (+local collector)',
      ...headers,
    },
  };
  if (body != null && !Object.keys(requestOptions.headers).some((key) => key.toLowerCase() === 'content-type')) {
    requestOptions.headers['content-type'] = 'application/json';
  }
  if (body != null && !Object.keys(requestOptions.headers).some((key) => key.toLowerCase() === 'content-length')) {
    requestOptions.headers['content-length'] = String(Buffer.byteLength(String(body)));
  }
  const maxRetries = throwOnHttpError ? Math.max(0, Number(retries) || 0) : 0;
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (signal?.aborted) throw new Error('请求已取消');
      const response = await requestWithRedirects(url, requestOptions);
      if (throwOnHttpError && (response.status < 200 || response.status >= 300)) {
        const error = new Error(`HTTP ${response.status}`);
        error.status = response.status;
        error.body = String(response.text || '').slice(0, 2000);
        throw error;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (maxRetries === 0 || attempt >= maxRetries) break;
      await delay(Math.min(5_000, 400 * (2 ** attempt)));
    }
  }
  const error = new Error(throwOnHttpError
    ? `${lastError?.message || '请求失败'}（已重试 ${maxRetries} 次）`
    : (lastError?.message || '请求失败'));
  if (lastError?.status) error.status = lastError.status;
  if (lastError?.body) error.body = lastError.body;
  throw error;
}

export function isSupportedProxy(proxyUrl) {
  return !proxyUrl || !!parseProxy(proxyUrl);
}
