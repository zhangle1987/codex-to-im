import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let createdTempHome: string | null = null;

function isManagedTestHome(value: string | undefined): boolean {
  if (!value) return false;
  const resolved = path.resolve(value);
  const tmpRoot = path.resolve(os.tmpdir());
  return resolved.startsWith(tmpRoot)
    && path.basename(resolved).startsWith('codex-to-im-test-');
}

if (
  !process.env.CTI_HOME
  || (
    process.env.CTI_TEST_ALLOW_EXTERNAL_HOME !== '1'
    && !isManagedTestHome(process.env.CTI_HOME)
  )
) {
  createdTempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-to-im-test-'));
  process.env.CTI_HOME = createdTempHome;
}

if (createdTempHome) {
  process.on('exit', () => {
    try {
      fs.rmSync(createdTempHome!, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures in tests
    }
  });
}
