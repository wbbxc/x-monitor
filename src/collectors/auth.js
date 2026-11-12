// 统一采集认证：密文落库，运行时才解密为请求头。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, saveEnvValues } from '../config.js';

const CIPHER = 'aes-256-gcm';
const VERSION = 'v1';
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding']);

function keyBuffer(value) {
  if (Buffer.isBuffer(value) && value.length === 32) return value;
  if (value instanceof Uint8Array && value.byteLength === 32) return Buffer.from(value);
  if (typeof value === 'string' && value.trim()) {
    const raw = value.trim();
    if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
    return crypto.createHash('sha256').update(raw).digest();
  }
  throw new Error('采集认证密钥无效');
}

function keyFile() {
  return path.join(config.dataDir, '.collector-key');
}

/** 本地未配置环境密钥时，生成只读本机密钥；data/ 已在 .gitignore 中。 */
export function getEncryptionKey() {
  if (config.collector?.masterKey) return keyBuffer(config.collector.masterKey);
  const file = keyFile();
  try {
    const saved = fs.readFileSync(file);
    if (saved.length === 32) return saved;
  } catch {}
  const generated = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, generated, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
  return generated;
}

export function encryptSecret(value, key = getEncryptionKey()) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(CIPHER, keyBuffer(key), iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decryptSecret(value, key = getEncryptionKey()) {
  if (typeof value !== 'string' || !value.startsWith(`${VERSION}.`)) throw new Error('采集认证密文格式无效');
  const [, ivText, tagText, dataText] = value.split('.');
  const decipher = crypto.createDecipheriv(CIPHER, keyBuffer(key), Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(dataText, 'base64url')), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}

function safeHeaderName(name) {
  const value = String(name || '').trim();
  if (!value || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value) || FORBIDDEN_HEADERS.has(value.toLowerCase())) {
    throw new Error(`认证请求头名称无效: ${value || '(空)'}`);
  }
  return value;
}

function safeHeaderValue(value) {
  const result = String(value ?? '');
  if (/[\r\n]/.test(result)) throw new Error('认证请求头不能包含换行');
  return result;
}

function cookieHeader(cookies) {
  if (typeof cookies === 'string') return safeHeaderValue(cookies.trim());
  if (!cookies || typeof cookies !== 'object' || Array.isArray(cookies)) throw new Error('cookie 必须是字符串或对象');
  return Object.entries(cookies)
    .filter(([name, value]) => String(name).trim() && value != null)
    .map(([name, value]) => `${safeHeaderName(name)}=${safeHeaderValue(value)}`)
    .join('; ');
}

/** 校验并规范化 API 输入；返回值可安全加密保存。 */
export function normalizeAuth(input = {}) {
  const type = String(input.type || 'none').trim().toLowerCase();
  if (type === 'none') return { type: 'none' };
  if (type === 'cookie') {
    const cookies = input.cookies ?? input.value;
    const header = cookieHeader(cookies);
    if (!header) throw new Error('cookie 不能为空');
    return { type, cookies: typeof cookies === 'string' ? header : cookies };
  }
  if (type === 'bearer' || type === 'token') {
    const token = safeHeaderValue(input.token ?? input.value).trim();
    if (!token) throw new Error('token 不能为空');
    return { type, token, header: input.header ? safeHeaderName(input.header) : 'Authorization' };
  }
  if (type === 'api_key') {
    const token = safeHeaderValue(input.token ?? input.value).trim();
    if (!token) throw new Error('api_key 不能为空');
    return { type, token, header: safeHeaderName(input.header || 'X-API-Key') };
  }
  if (type === 'basic') {
    const username = safeHeaderValue(input.username).trim();
    const password = safeHeaderValue(input.password);
    if (!username) throw new Error('basic 用户名不能为空');
    return { type, username, password };
  }
  if (type === 'headers') {
    if (!input.headers || typeof input.headers !== 'object' || Array.isArray(input.headers)) {
      throw new Error('headers 必须是对象');
    }
    const headers = {};
    for (const [name, value] of Object.entries(input.headers)) {
      headers[safeHeaderName(name)] = safeHeaderValue(value);
    }
    if (!Object.keys(headers).length) throw new Error('headers 不能为空');
    return { type, headers };
  }
  if (type === 'fields') {
    const source = input.fields ?? input.value;
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw new Error('fields 必须是对象');
    }
    const fields = {};
    for (const [name, value] of Object.entries(source)) {
      const key = String(name || '').trim();
      if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key)) throw new Error(`认证字段名称无效: ${key || '(空)'}`);
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error(`认证字段名称无效: ${key}`);
      if (value == null) continue;
      fields[key] = safeHeaderValue(value);
    }
    if (!Object.keys(fields).length) throw new Error('fields 不能为空');
    return { type, fields };
  }
  throw new Error(`不支持的认证类型: ${type}`);
}

export function buildAuthHeaders(secret = { type: 'none' }) {
  const auth = normalizeAuth(secret);
  if (auth.type === 'none') return {};
  if (auth.type === 'cookie') return { cookie: cookieHeader(auth.cookies) };
  if (auth.type === 'bearer') return { [auth.header || 'Authorization']: `Bearer ${auth.token}` };
  if (auth.type === 'token') return { [auth.header || 'Authorization']: auth.token };
  if (auth.type === 'api_key') return { [auth.header || 'X-API-Key']: auth.token };
  if (auth.type === 'basic') {
    return { authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}` };
  }
  return { ...auth.headers };
}

export function redactAuth(secret) {
  if (!secret) return { type: 'none', configured: false };
  const type = String(secret.type || 'none');
  return { type, configured: type !== 'none' };
}

function environmentAuth() {
  const raw = process.env.COLLECTOR_AUTH_JSON?.trim();
  if (!raw) return null;
  let value;
  try { value = JSON.parse(raw); }
  catch { throw new Error('COLLECTOR_AUTH_JSON 必须为合法 JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('COLLECTOR_AUTH_JSON 必须为对象');
  }
  for (const key of ['sources', 'platforms']) {
    if (value[key] !== undefined && (!value[key] || typeof value[key] !== 'object' || Array.isArray(value[key]))) {
      throw new Error('COLLECTOR_AUTH_JSON 的 sources/platforms 必须为对象');
    }
  }
  return value;
}

export function readEnvironmentAuth(source) {
  const value = environmentAuth();
  if (!value || !source) return null;
  if (Object.hasOwn(value.sources || {}, source.url)) return normalizeAuth(value.sources[source.url]);
  if (Object.hasOwn(value.platforms || {}, source.platform)) return normalizeAuth(value.platforms[source.platform]);
  return null;
}

export function saveEnvironmentAuth(source, auth) {
  const value = environmentAuth();
  if (!value || !source) return false;
  value.sources = { ...value.sources, [source.url]: normalizeAuth(auth) };
  saveEnvValues({ COLLECTOR_AUTH_JSON: JSON.stringify(value) });
  return true;
}
