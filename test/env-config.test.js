import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));

function isolated(run, content = '') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xmonitor-env-'));
  const file = path.join(directory, '.env');
  fs.writeFileSync(file, content);
  const env = { ...process.env, XMONITOR_ENV_FILE: file, DATA_DIR: path.join(directory, 'data'),
    X_ACCOUNTS_JSON: '', COLLECTOR_AUTH_JSON: '', COLLECTOR_MASTER_KEY: '', HF_SYNC_ENABLED: 'false' };
  delete env.X_ACCOUNTS_JSON;
  delete env.COLLECTOR_AUTH_JSON;
  try { run({ directory, file, env }); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

function node(script, env) {
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, env, encoding: 'utf8' }).trim();
}

test('The environment template lists every application configuration variable', () => {
  const source = fs.readFileSync(path.join(root, 'src/config.js'), 'utf8');
  const template = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  for (const [, name] of source.matchAll(/process\.env\.([A-Z][A-Z_0-9]*)/g)) {
    assert.match(template, new RegExp(`^#?\\s*${name}=`, 'm'), name);
  }
});

test('X accounts from .env drive both scraper entry points without an accounts file', () => {
  isolated(({ env }) => {
    const result = node(`
      import { readXAccounts } from './src/config.js';
      import { resolveMode } from './src/scraper.js';
      import { buildXArgs } from './src/collectors/x.js';
      console.log(JSON.stringify({ count: readXAccounts().accounts.length, mode: resolveMode(),
        args: buildXArgs({ kind: 'account', value: 'example' }, {}) }));
    `, env);
    const parsed = JSON.parse(result);
    assert.equal(parsed.count, 1);
    assert.equal(parsed.mode, 'real');
    assert.equal(parsed.args.at(-1), 'real');
  }, 'SCRAPE_MODE=auto\nX_ACCOUNTS_JSON=\'{"accounts":[{"username":"env_example","password":"fixture-only"}]}\'\n');
});

test('Explicit empty X accounts disable legacy file fallback and malformed values are redacted', () => {
  isolated(({ env }) => {
    assert.equal(node(`import { resolveMode } from './src/scraper.js'; console.log(resolveMode());`, env), 'mock');
    env.X_ACCOUNTS_JSON = '{"password":"do-not-log-this"';
    const output = node(`import { readXAccounts } from './src/config.js'; try { readXAccounts(); } catch(error) { console.log(error.message); }`, env);
    assert.match(output, /X_ACCOUNTS_JSON/);
    assert.doesNotMatch(output, /do-not-log-this/);
  }, 'SCRAPE_MODE=auto\nX_ACCOUNTS_JSON=[]\n');
});

test('Environment saves preserve unrelated secrets, literal replacement characters and restricted permissions', () => {
  isolated(({ file, env }) => {
    node(`import { saveEnvValues } from './src/config.js'; saveEnvValues({ LLM_API_KEY: "literal-$&-$1-引号'", LLM_MODEL: 'updated' });`, env);
    const content = fs.readFileSync(file, 'utf8');
    assert.match(content, /^X_ACCOUNTS_JSON=\[\]$/m);
    assert.match(content, /^LLM_API_KEY=literal-\$&-\$1-引号'$/m);
    assert.match(content, /^LLM_MODEL=updated$/m);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const original = content;
    node(`import { saveEnvValues } from './src/config.js'; try { saveEnvValues({ LLM_MODEL: 'bad\\nINJECTED=value' }); } catch(error) { console.log(error.message); }`, env);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  }, 'X_ACCOUNTS_JSON=[]\nLLM_API_KEY=old\n');
});

test('Source credentials read from .env and UI-style changes stay in .env without exposing secrets', () => {
  isolated(({ file, env }) => {
    const output = node(`
      import assert from 'node:assert/strict';
      import { collectionSources, collectionAuth } from './src/db.js';
      const source = collectionSources.upsert({ platform: 'github', name: 'fixture', url: 'https://github.com/example/repo' });
      assert.equal(collectionAuth.get(source.id).token, 'initial-fixture');
      const status = collectionAuth.set(source.id, { type: 'token', token: 'updated-fixture' });
      assert.equal(status.configured, true);
      assert.equal(JSON.stringify(status).includes('updated-fixture'), false);
      assert.equal(collectionAuth.get(source.id).token, 'updated-fixture');
      collectionAuth.remove(source.id);
      assert.deepEqual(collectionAuth.get(source.id), { type: 'none' });
      assert.equal(collectionAuth.status(source.id).configured, false);
      console.log('ok');
    `, env);
    assert.equal(output, 'ok');
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /updated-fixture/);
    assert.match(fs.readFileSync(file, 'utf8'), /"https:\/\/github.com\/example\/repo":\{"type":"none"\}/);
  }, 'COLLECTOR_AUTH_JSON=\'{"sources":{},"platforms":{"github":{"type":"token","token":"initial-fixture"}}}\'\n');
});

test('Python direct worker reads the same .env accounts and respects explicit empty configuration', () => {
  isolated(({ env }) => {
    const script = `import sys; sys.path.insert(0, 'python'); from local_settings import load_x_accounts; import json; print(json.dumps(load_x_accounts()))`;
    const result = JSON.parse(execFileSync('python3', ['-c', script], { cwd: root, env, encoding: 'utf8' }));
    assert.equal(result.accounts[0].username, 'env_example');
    env.X_ACCOUNTS_JSON = '[]';
    const empty = JSON.parse(execFileSync('python3', ['-c', script], { cwd: root, env, encoding: 'utf8' }));
    assert.deepEqual(empty.accounts, []);
  }, 'X_ACCOUNTS_JSON=\'{"accounts":[{"username":"env_example","cookies":{"auth_token":"fixture","ct0":"fixture"}}]}\'\n');
});

test('Settings and source authentication APIs share the isolated environment file without leaking values', () => {
  isolated(({ file, env }) => {
    env.PORT = '0';
    env.HOST = '127.0.0.1';
    const output = node(`
      import assert from 'node:assert/strict';
      import { startServer } from './src/server.js';
      const server = startServer();
      if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
      const base = 'http://127.0.0.1:' + server.address().port;
      const request = (method, body) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      try {
        let response = await fetch(base + '/api/collections/sources', request('POST', {
          platform: 'arxiv', name: 'env-api-fixture', url: 'https://export.arxiv.org/api/query',
          auth: { type: 'bearer', token: 'fixture-api-token' },
        }));
        assert.equal(response.status, 200);
        const source = await response.json();
        assert.equal(source.auth.storage, 'env');
        assert.equal(JSON.stringify(source).includes('fixture-api-token'), false);
        response = await fetch(base + '/api/settings', request('PUT', { LLM_API_KEY: 'fixture-$&-key' }));
        assert.equal(response.status, 200);
        response = await fetch(base + '/api/collections/sources');
        assert.equal((await response.text()).includes('fixture-api-token'), false);
        response = await fetch(base + '/api/collections/sources/' + source.id + '/auth', { method: 'DELETE' });
        assert.equal(response.status, 200);
        console.log('api-ok');
      } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    `, env);
    assert.match(output, /api-ok/);
    const content = fs.readFileSync(file, 'utf8');
    assert.match(content, /^LLM_API_KEY=fixture-\$&-key$/m);
    assert.doesNotMatch(content, /fixture-api-token/);
    assert.match(content, /^X_ACCOUNTS_JSON=\[\]$/m);
  }, 'X_ACCOUNTS_JSON=[]\nCOLLECTOR_AUTH_JSON={"sources":{},"platforms":{}}\n');
});
