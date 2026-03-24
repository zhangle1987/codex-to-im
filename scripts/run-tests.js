import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-to-im-test-'));
const testsDir = path.join(process.cwd(), 'src', '__tests__');
const testFiles = fs.readdirSync(testsDir)
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => path.join('src', '__tests__', name));

const child = spawn(
  process.execPath,
  [
    '--test',
    '--test-concurrency=1',
    '--import',
    'tsx',
    '--test-timeout=15000',
    ...testFiles,
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      CTI_HOME: tempHome,
    },
  },
);

child.on('exit', (code, signal) => {
  try {
    fs.rmSync(tempHome, { recursive: true, force: true });
  } catch {
    // ignore
  }

  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});
