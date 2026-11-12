// HTTPS 代理回归测试：必须走 CONNECT 隧道，不能因为请求构造问题退回直连。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchText } from '../src/collectors/http.js';

// 测试证书是自签的，仅用于本机回环地址。
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const key = fs.readFileSync(path.join(__dirname, 'fixtures/proxy-test-key.pem'));
const cert = fs.readFileSync(path.join(__dirname, 'fixtures/proxy-test-cert.pem'));

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  });
}

function createProxy() {
  const state = { connects: 0, sockets: new Set() };
  const proxy = http.createServer();
  proxy.on('connect', (req, clientSocket, head) => {
    state.connects++;
    state.sockets.add(clientSocket);
    clientSocket.on('close', () => state.sockets.delete(clientSocket));
    const [host, port] = String(req.url).split(':');
    const target = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) target.write(head);
      target.pipe(clientSocket);
      clientSocket.pipe(target);
    });
    target.on('error', () => clientSocket.destroy());
    target.on('close', () => clientSocket.destroy());
    clientSocket.on('error', () => target.destroy());
    clientSocket.on('close', () => target.destroy());
  });
  return { proxy, state };
}

test('HTTPS 请求经 CONNECT 隧道转发，不退回直连', async () => {
  const target = https.createServer({ key, cert }, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`proxied:${req.url}`);
  });
  const targetPort = await listen(target);
  const { proxy, state } = createProxy();
  const proxyPort = await listen(proxy);
  try {
    const response = await fetchText(`https://localhost:${targetPort}/probe`, {
      proxy: `http://127.0.0.1:${proxyPort}`,
      timeoutMs: 4000,
      retries: 0,
      headers: { connection: 'close' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.text, 'proxied:/probe');
    assert.equal(state.connects, 1, '请求必须经过代理的 CONNECT');
  } finally {
    for (const socket of state.sockets) socket.destroy();
    await close(proxy);
    await close(target);
  }
});

test('代理拒绝 CONNECT 时返回明确错误', async () => {
  const proxy = http.createServer();
  proxy.on('connect', (req, socket) => {
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  const proxyPort = await listen(proxy);
  try {
    await assert.rejects(
      fetchText('https://example.com/', { proxy: `http://127.0.0.1:${proxyPort}`, timeoutMs: 2000, retries: 0 }),
      /代理 CONNECT 失败（HTTP 403）/
    );
  } finally {
    await close(proxy);
  }
});

test('HTTP/2 代理请求可用并解压 gzip 响应', async () => {
  const target = http2.createSecureServer({ key, cert }, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
    res.end(zlib.gzipSync('{"ok":true}'));
  });
  const targetPort = await listen(target);
  const { proxy, state } = createProxy();
  const proxyPort = await listen(proxy);
  try {
    const response = await fetchText(`https://localhost:${targetPort}/h2`, {
      proxy: `http://127.0.0.1:${proxyPort}`,
      http2: true,
      timeoutMs: 4000,
      retries: 0,
      headers: { 'user-agent': 'test' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.text, '{"ok":true}');
    assert.equal(state.connects, 1);
  } finally {
    for (const socket of state.sockets) socket.destroy();
    await close(proxy);
    await close(target);
  }
});

test('目标不支持 HTTP/2 时回退到 HTTP/1.1', async () => {
  const target = https.createServer({ key, cert }, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('fallback-h1');
  });
  const targetPort = await listen(target);
  const { proxy, state } = createProxy();
  const proxyPort = await listen(proxy);
  try {
    const response = await fetchText(`https://localhost:${targetPort}/fallback`, {
      proxy: `http://127.0.0.1:${proxyPort}`,
      http2: true,
      timeoutMs: 4000,
      retries: 0,
      headers: { connection: 'close' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.text, 'fallback-h1');
  } finally {
    for (const socket of state.sockets) socket.destroy();
    await close(proxy);
    await close(target);
  }
});

test('HTTP/1.1 响应按 content-encoding 解压', async () => {
  const target = https.createServer({ key, cert }, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
    res.end(zlib.gzipSync('{"ok":"h1"}'));
  });
  const targetPort = await listen(target);
  const { proxy, state } = createProxy();
  const proxyPort = await listen(proxy);
  try {
    const response = await fetchText(`https://localhost:${targetPort}/gzip`, {
      proxy: `http://127.0.0.1:${proxyPort}`,
      timeoutMs: 4000,
      retries: 0,
      headers: { 'accept-encoding': 'gzip', connection: 'close' },
    });
    assert.equal(response.text, '{"ok":"h1"}');
  } finally {
    for (const socket of state.sockets) socket.destroy();
    await close(proxy);
    await close(target);
  }
});
