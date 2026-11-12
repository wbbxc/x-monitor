import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));

test('Git ignores local credentials, backups and private keys but retains templates and test fixtures', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'x-monitor-git-safety-'));
  try {
    execFileSync('git', ['init', '--quiet', directory]);
    fs.copyFileSync(path.join(root, '.gitignore'), path.join(directory, '.gitignore'));
    const ignored = [
      '.env', '.env.production', '.env.staging', '.env.local.bak',
      'python/accounts.json', 'python/accounts.json.bak', 'python/accounts.json.backup',
      'python/accounts.db', 'data/.collector-key', 'data/collector/github.yaml',
      'cookies.json', 'cookies.local.json', 'credentials.json', 'credentials.local.json',
      'storage-state.json', 'telegram.session', 'telegram.session-journal',
      'private.key', 'server.pem', 'id_ed25519', 'backups/accounts.json',
    ];
    const result = execFileSync('git', ['-c', 'core.excludesFile=/dev/null', 'check-ignore', '--no-index', '--stdin'], {
      cwd: directory, input: ignored.join('\n') + '\n', encoding: 'utf8',
    }).trim().split('\n');
    assert.deepEqual(result, ignored);
    for (const file of ['.env.example', '.env.production.example', 'python/accounts.example.json',
      'src/config.js', 'test/fixtures/proxy-test-key.pem', 'test/fixtures/proxy-test-cert.pem']) {
      assert.throws(() => execFileSync('git', ['-c', 'core.excludesFile=/dev/null', 'check-ignore', '--no-index', file], {
        cwd: directory, stdio: 'pipe',
      }), error => error.status === 1, file);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Git index contains no runtime credentials or data files', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const sensitive = files.filter(file => /(^|\/)(data|backups|secrets|private)\//.test(file)
    || /(^|\/)\.env(?:\..*)?$/.test(file) && !/\.example$/.test(file)
    || /(^|\/)(accounts\.json(?:\..*)?|cookies(?:\.[^/]*)?\.json|credentials(?:\.[^/]*)?\.json|storage-state\.json|id_(rsa|ed25519|ecdsa))$/.test(file)
    || /\.(?:db(?:-shm|-wal)?|session(?:-journal)?|key|p12|pfx)$/.test(file));
  assert.deepEqual(sensitive, []);
});

test('Sensitive environment template values stay empty', () => {
  const template = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  for (const line of template.split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]*(?:KEY|TOKEN|SECRET|PASSWORD))=(.*)$/);
    if (!match) continue;
    if (match[1] === 'LLM_REQUIRE_KEY') assert.match(match[2], /^(true|false)$/);
    else assert.equal(match[2].trim(), '', match[1]);
  }
  assert.match(template, /^X_ACCOUNTS_JSON=\[\]$/m);
  assert.match(template, /^COLLECTOR_AUTH_JSON=\{"sources":\{\},"platforms":\{\}\}$/m);
});
