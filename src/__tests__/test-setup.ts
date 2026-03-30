import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let createdTempHome: string | null = null;

if (!process.env.CTI_HOME) {
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
