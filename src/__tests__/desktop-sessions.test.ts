import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { listDesktopSessions } from '../desktop-sessions.js';

const originalCodexHome = process.env.CODEX_HOME;

afterEach(() => {
  if (originalCodexHome === undefined) {
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = originalCodexHome;
  }
});

describe('listDesktopSessions', () => {
  it('falls back to the first real user message when session_index has no title', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-desktop-sessions-'));
    process.env.CODEX_HOME = tempRoot;

    const sessionsDir = path.join(tempRoot, 'sessions', '2026', '03', '24');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const threadId = '019d08ea-d078-7940-bafa-ae28ae13b3fc';
    const cwd = 'D:\\codex\\crm';
    const rolloutPath = path.join(sessionsDir, `rollout-2026-03-24T10-00-00-${threadId}.jsonl`);
    fs.writeFileSync(
      rolloutPath,
      [
        JSON.stringify({
          timestamp: '2026-03-24T02:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: threadId,
            timestamp: '2026-03-24T02:00:00.000Z',
            cwd,
            originator: 'Codex Desktop',
            source: 'vscode',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-24T02:00:01.000Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: '这是一套crm工程，请仔细阅读文档和代码，熟悉整个项目的架构和细节。',
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const sessions = listDesktopSessions(10);

    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.threadId, threadId);
    assert.match(sessions[0]?.title || '', /^这是一套crm工程/);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('hides internal exec sessions that are not shown in the Codex desktop sidebar', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-desktop-sessions-'));
    process.env.CODEX_HOME = tempRoot;

    const sessionsDir = path.join(tempRoot, 'sessions', '2026', '03', '24');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const rolloutPath = path.join(
      sessionsDir,
      'rollout-2026-03-24T13-04-00-019d1e3a-74f9-7e43-92ef-e206eec01f80.jsonl',
    );
    fs.writeFileSync(
      rolloutPath,
      [
        JSON.stringify({
          timestamp: '2026-03-24T05:04:17.166Z',
          type: 'session_meta',
          payload: {
            id: '019d1e3a-74f9-7e43-92ef-e206eec01f80',
            timestamp: '2026-03-24T05:04:00.768Z',
            cwd: 'D:\\codex\\Claude-to-IM-skill',
            originator: 'Codex Desktop',
            source: 'exec',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-24T05:04:17.166Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: 'Write 6 short paragraphs about background services. No tools.',
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const sessions = listDesktopSessions(10);

    assert.equal(sessions.length, 0);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});
