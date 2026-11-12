import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xmonitor-test-env-'));
process.env.XMONITOR_ENV_FILE = path.join(directory, '.env');
process.env.DATA_DIR = path.join(directory, 'data');
process.env.X_ACCOUNTS_JSON = '[]';
process.env.COLLECTOR_AUTH_JSON = '';
process.env.COLLECTOR_MASTER_KEY = '';
process.env.LLM_API_KEY = '';
process.env.X_PROXY = '';
process.env.COLLECTOR_PROXY = '';
fs.writeFileSync(process.env.XMONITOR_ENV_FILE, '', { mode: 0o600 });
process.on('exit', () => fs.rmSync(directory, { recursive: true, force: true }));
