import './test-setup.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import {
  listDesktopSessions,
  readDesktopSessionEventDeltaByFilePath,
  readDesktopSessionEventStreamByFilePath,
  readDesktopSessionMessagesByFilePath,
  readDesktopSessionMirrorRecordDeltaByFilePath,
  readDesktopSessionMirrorRecordStreamByFilePath,
} from '../desktop-sessions.js';

const originalCodexHome = process.env.CODEX_HOME;
const localRequire = createRequire(import.meta.url);

function getTestDatabaseSync(): (new (filePath: string) => {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): unknown };
  close(): void;
}) | null {
  try {
    return localRequire('node:sqlite').DatabaseSync;
  } catch {
    return null;
  }
}

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

  it('ignores session_meta source objects from subagent threads instead of throwing', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-desktop-sessions-'));
    process.env.CODEX_HOME = tempRoot;

    const sessionsDir = path.join(tempRoot, 'sessions', '2026', '04', '02');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const rolloutPath = path.join(
      sessionsDir,
      'rollout-2026-04-02T20-01-32-019d4e11-f45a-7970-b568-946693ff750c.jsonl',
    );
    fs.writeFileSync(
      rolloutPath,
      [
        JSON.stringify({
          timestamp: '2026-04-02T12:01:32.019Z',
          type: 'session_meta',
          payload: {
            id: '019d4e11-f45a-7970-b568-946693ff750c',
            timestamp: '2026-04-02T12:01:32.019Z',
            cwd: 'D:\\codex\\Claude-to-IM-skill',
            originator: 'codex_sdk_ts',
            source: {
              subagent: {
                thread_spawn: {
                  parent_thread_id: '019d3de4-856e-7dd1-a16e-7a2d84926775',
                  depth: 1,
                  agent_nickname: 'Curie',
                  agent_role: 'explorer',
                },
              },
            },
          },
        }),
        JSON.stringify({
          timestamp: '2026-04-02T12:01:33.000Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: '请分析这个子任务',
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const sessions = listDesktopSessions(10);

    assert.deepEqual(sessions, []);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('hides desktop threads whose cwd points at the internal skills workspace', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-desktop-sessions-'));
    process.env.CODEX_HOME = tempRoot;

    const sessionsDir = path.join(tempRoot, 'sessions', '2026', '03', '24');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const rolloutPath = path.join(
      sessionsDir,
      'rollout-2026-03-24T10-13-10-019d1d9e-0be2-7053-886d-ff078ef17084.jsonl',
    );
    fs.writeFileSync(
      rolloutPath,
      [
        JSON.stringify({
          timestamp: '2026-03-24T02:13:10.245Z',
          type: 'session_meta',
          payload: {
            id: '019d1d9e-0be2-7053-886d-ff078ef17084',
            timestamp: '2026-03-24T02:13:10.245Z',
            cwd: path.join(tempRoot, 'skills', 'codex-to-im'),
            originator: 'Codex Desktop',
            source: 'vscode',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-24T02:13:11.000Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: '请阅读和了解这个项目',
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const sessions = listDesktopSessions(12);

    assert.equal(sessions.length, 0);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('hides desktop threads whose project root is no longer in the desktop saved workspace list', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-desktop-sessions-'));
    process.env.CODEX_HOME = tempRoot;

    const sessionsDir = path.join(tempRoot, 'sessions', '2026', '03', '24');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const visibleThreadId = '019cdc07-1238-7573-a42a-e5f2341f00b9';
    const hiddenThreadId = '019cdb48-d2a3-7821-83dd-14a61f629760';
    for (const [threadId, cwd, title] of [
      [visibleThreadId, 'C:\\Users\\zhangle\\WeChatProjects\\miniprogram-1', '保留的桌面项目'],
      [hiddenThreadId, 'D:\\codex\\dinosaur', '已移除的桌面项目'],
    ] as const) {
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
              message: title,
            },
          }),
        ].join('\n'),
        'utf-8',
      );
    }

    fs.writeFileSync(
      path.join(tempRoot, '.codex-global-state.json'),
      JSON.stringify({
        'electron-saved-workspace-roots': ['C:\\Users\\zhangle\\WeChatProjects\\miniprogram-1'],
      }),
      'utf-8',
    );

    const sessions = listDesktopSessions();

    assert.deepEqual(sessions.map((session) => session.threadId), [visibleThreadId]);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('includes freshly created desktop threads that have reached session_index before the state db catches up', (t) => {
    const DatabaseSync = getTestDatabaseSync();
    if (!DatabaseSync) {
      t.skip('node:sqlite is unavailable on this Node version');
      return;
    }
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-desktop-sessions-'));
    process.env.CODEX_HOME = tempRoot;

    const sessionsDir = path.join(tempRoot, 'sessions', '2026', '03', '26');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const visibleThreadId = '019d2303-06e4-73e2-8857-00444446ceb0';
    const freshThreadId = '019d27aa-5d8d-7ab3-89df-3d28fed5730a';
    const staleThreadId = '019cdb48-d2a3-7821-83dd-14a61f629760';

    for (const [threadId, title] of [
      [visibleThreadId, '当前桌面可见会话'],
      [freshThreadId, '测试工程2'],
      [staleThreadId, '已经不在桌面里的旧会话'],
    ] as const) {
      const rolloutPath = path.join(sessionsDir, `rollout-2026-03-26T09-00-00-${threadId}.jsonl`);
      fs.writeFileSync(
        rolloutPath,
        [
          JSON.stringify({
            timestamp: '2026-03-26T01:00:00.000Z',
            type: 'session_meta',
            payload: {
              id: threadId,
              timestamp: '2026-03-26T01:00:00.000Z',
              cwd: 'D:\\codex\\test',
              originator: 'Codex Desktop',
              source: 'vscode',
            },
          }),
          JSON.stringify({
            timestamp: '2026-03-26T01:00:01.000Z',
            type: 'event_msg',
            payload: {
              type: 'user_message',
              message: title,
            },
          }),
        ].join('\n'),
        'utf-8',
      );
    }

    fs.writeFileSync(
      path.join(tempRoot, 'session_index.jsonl'),
      [
        JSON.stringify({
          id: visibleThreadId,
          thread_name: '当前桌面可见会话',
          updated_at: '2026-03-26T01:00:00.000Z',
        }),
        JSON.stringify({
          id: staleThreadId,
          thread_name: '已经不在桌面里的旧会话',
          updated_at: '2026-03-25T01:00:00.000Z',
        }),
        JSON.stringify({
          id: freshThreadId,
          thread_name: '测试工程2',
          updated_at: '2026-03-26T01:03:12.626Z',
        }),
      ].join('\n'),
      'utf-8',
    );

    const db = new DatabaseSync(path.join(tempRoot, 'state_5.sqlite'));
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        updated_at INTEGER NOT NULL,
        archived INTEGER NOT NULL,
        source TEXT NOT NULL
      );
    `);
    db.prepare(`INSERT INTO threads (id, updated_at, archived, source) VALUES (?, ?, 0, 'vscode')`)
      .run(visibleThreadId, Math.floor(Date.parse('2026-03-26T01:00:00.000Z') / 1000));
    db.close();

    const sessions = listDesktopSessions(10);
    const threadIds = sessions.map((session) => session.threadId);

    assert.deepEqual(threadIds, [freshThreadId, visibleThreadId]);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('prefers renamed session index titles while retaining state db fallbacks', (t) => {
    const DatabaseSync = getTestDatabaseSync();
    if (!DatabaseSync) {
      t.skip('node:sqlite is unavailable on this Node version');
      return;
    }
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-desktop-state-'));
    process.env.CODEX_HOME = tempRoot;
    const sessionsDir = path.join(tempRoot, 'sessions', '2026', '07', '20');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const userThreadId = '019f7dc8-55df-76f0-8b98-99b548eb6885';
    const subagentThreadId = '019f7dc8-55df-76f0-8b98-99b548eb6886';
    const fallbackThreadId = '019f7dc8-55df-76f0-8b98-99b548eb6887';

    const writeRollout = (threadId: string, source: unknown) => {
      const rolloutPath = path.join(sessionsDir, `rollout-2026-07-20T12-28-34-${threadId}.jsonl`);
      fs.writeFileSync(rolloutPath, JSON.stringify({
        type: 'session_meta',
        payload: {
          id: threadId,
          cwd: 'D:\\codex\\test',
          originator: 'Codex Desktop',
          source,
        },
      }) + '\n', 'utf8');
      return rolloutPath;
    };
    const userRolloutPath = writeRollout(userThreadId, 'vscode');
    const subagentRolloutPath = writeRollout(subagentThreadId, { subagent: { parent_thread_id: userThreadId } });
    const fallbackRolloutPath = writeRollout(fallbackThreadId, 'vscode');

    fs.writeFileSync(
      path.join(tempRoot, 'session_index.jsonl'),
      [
        JSON.stringify({
          id: userThreadId,
          thread_name: 'Initial generated title',
          updated_at: '2026-07-20T04:28:40.000Z',
        }),
        JSON.stringify({
          id: userThreadId,
          thread_name: 'Renamed desktop title',
          updated_at: '2026-07-20T08:01:15.000Z',
        }),
      ].join('\n'),
      'utf8',
    );

    const db = new DatabaseSync(path.join(tempRoot, 'state_5.sqlite'));
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT,
        updated_at INTEGER NOT NULL,
        updated_at_ms INTEGER,
        archived INTEGER NOT NULL,
        source TEXT,
        thread_source TEXT,
        title TEXT,
        cwd TEXT
      );
    `);
    const insert = db.prepare(`
      INSERT INTO threads
        (id, rollout_path, updated_at, updated_at_ms, archived, source, thread_source, title, cwd)
      VALUES (?, ?, 1, ?, 0, 'vscode', ?, ?, 'D:\\codex\\test')
    `);
    insert.run(userThreadId, userRolloutPath, 2_000, 'user', 'Legacy first user prompt');
    insert.run(subagentThreadId, subagentRolloutPath, 3_000, 'subagent', 'Hidden subagent');
    insert.run(fallbackThreadId, fallbackRolloutPath, 1_500, 'user', 'State db fallback title');
    db.close();

    try {
      const sessions = listDesktopSessions(10);
      assert.deepEqual(sessions.map((session) => session.threadId), [userThreadId, fallbackThreadId]);
      assert.equal(sessions[0]?.title, 'Renamed desktop title');
      assert.equal(sessions[0]?.filePath, userRolloutPath);
      assert.equal(sessions[1]?.title, 'State db fallback title');
      assert.equal(sessions[1]?.filePath, fallbackRolloutPath);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('readDesktopSessionEventStreamByFilePath', () => {
  it('falls back to task_complete.last_agent_message for final answers', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-desktop-events-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-03-25T00:00:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: 'hello',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-25T00:00:02.000Z',
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            last_agent_message: 'final answer',
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const events = readDesktopSessionEventStreamByFilePath(filePath);

    assert.deepEqual(
      events.map((event) => ({ role: event.role, content: event.content })),
      [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'final answer' },
      ],
    );

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('falls back to turn.completed messages for final answers', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-desktop-events-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-05-22T00:00:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'turn.completed',
            turn_id: 'turn-completed',
            message: [
              { type: 'output_text', text: 'final answer' },
            ],
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const events = readDesktopSessionEventStreamByFilePath(filePath);

    assert.deepEqual(
      events.map((event) => ({ role: event.role, content: event.content })),
      [
        { role: 'assistant', content: 'final answer' },
      ],
    );

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('preserves markdown-style line breaks from task_complete.last_agent_message', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-desktop-events-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-03-25T00:00:02.000Z',
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            last_agent_message: '结论：\n- 第一项\n- 第二项\n\n下一步：继续验证',
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const events = readDesktopSessionEventStreamByFilePath(filePath);

    assert.deepEqual(
      events.map((event) => ({ role: event.role, content: event.content })),
      [
        {
          role: 'assistant',
          content: '结论：\n- 第一项\n- 第二项\n\n下一步：继续验证',
        },
      ],
    );

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('preserves line breaks from desktop user_message events', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-desktop-events-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-03-25T00:00:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: '第一行\n第二行\n\n第三行',
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const events = readDesktopSessionEventStreamByFilePath(filePath);

    assert.deepEqual(
      events.map((event) => ({ role: event.role, content: event.content })),
      [
        {
          role: 'user',
          content: '第一行\n第二行\n\n第三行',
        },
      ],
    );

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('reads agent_message event records without duplicating the matching response_item message', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-desktop-events-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-05-14T00:00:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'agent_message',
            message: '正在检查新版格式',
            phase: 'commentary',
          },
        }),
        JSON.stringify({
          timestamp: '2026-05-14T00:00:00.001Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            phase: 'commentary',
            content: [{ type: 'output_text', text: '正在检查新版格式' }],
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const events = readDesktopSessionEventStreamByFilePath(filePath);

    assert.deepEqual(
      events.map((event) => ({ role: event.role, content: event.content })),
      [{ role: 'commentary', content: '正在检查新版格式' }],
    );

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('reads only appended complete lines and preserves trailing partial text', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-desktop-events-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    const firstLine = JSON.stringify({
      timestamp: '2026-03-25T00:00:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: 'hello',
      },
    });
    const secondLine = JSON.stringify({
      timestamp: '2026-03-25T00:00:02.000Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        last_agent_message: 'final answer',
      },
    });
    fs.writeFileSync(filePath, `${firstLine}\n${secondLine.slice(0, 40)}`, 'utf-8');

    const firstDelta = readDesktopSessionEventDeltaByFilePath(filePath, 0, fs.statSync(filePath).size);

    assert.deepEqual(
      firstDelta.events.map((event) => ({ role: event.role, content: event.content })),
      [{ role: 'user', content: 'hello' }],
    );
    assert.equal(firstDelta.trailingText, '');
    assert.equal(firstDelta.nextOffset, Buffer.byteLength(`${firstLine}\n`, 'utf8'));

    fs.appendFileSync(filePath, `${secondLine.slice(40)}\n`, 'utf-8');
    const secondDelta = readDesktopSessionEventDeltaByFilePath(
      filePath,
      firstDelta.nextOffset,
      fs.statSync(filePath).size,
      firstDelta.trailingText,
    );

    assert.deepEqual(
      secondDelta.events.map((event) => ({ role: event.role, content: event.content })),
      [{ role: 'assistant', content: 'final answer' }],
    );
    assert.equal(secondDelta.trailingText, '');

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

describe('readDesktopSessionMessagesByFilePath', () => {
  it('reads recent history from the bounded file tail', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-desktop-history-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    const ignoredLine = JSON.stringify({
      timestamp: '2026-07-20T00:00:00.000Z',
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'large', output: 'x'.repeat(4_000) },
    });
    const lines = Array.from({ length: 400 }, () => ignoredLine);
    lines.push(JSON.stringify({
      timestamp: '2026-07-20T00:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'recent question' },
    }));
    lines.push(JSON.stringify({
      timestamp: '2026-07-20T00:00:02.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'recent answer' }] },
    }));
    fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');

    try {
      assert.deepEqual(readDesktopSessionMessagesByFilePath(filePath, 2), [
        { role: 'user', content: 'recent question' },
        { role: 'assistant', content: 'recent answer' },
      ]);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('readDesktopSessionMirrorRecordStreamByFilePath', () => {
  it('preserves task lifecycle records for mirror delivery', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-desktop-mirror-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-03-25T00:00:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'task_started',
            turn_id: 'turn-1',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-25T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'shell_command',
            call_id: 'call-1',
            arguments: '{"command":"dir"}',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-25T00:00:01.500Z',
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'call-1',
            output: 'Exit code: 0',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-25T00:00:01.700Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            phase: 'commentary',
            content: [{ type: 'output_text', text: 'thinking' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-25T00:00:02.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'final answer' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-25T00:00:03.000Z',
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            turn_id: 'turn-1',
            last_agent_message: 'final answer',
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const records = readDesktopSessionMirrorRecordStreamByFilePath(filePath);

    assert.deepEqual(
      records.map((record) => ({
        type: record.type,
        role: record.role,
        content: record.content,
        turnId: record.turnId,
      })),
      [
        { type: 'task_started', role: undefined, content: '', turnId: 'turn-1' },
        { type: 'tool_started', role: undefined, content: '', turnId: 'turn-1' },
        { type: 'tool_finished', role: undefined, content: 'Exit code: 0', turnId: 'turn-1' },
        { type: 'message', role: 'commentary', content: 'thinking', turnId: 'turn-1' },
        { type: 'message', role: 'assistant', content: 'final answer', turnId: 'turn-1' },
        { type: 'task_complete', role: 'assistant', content: 'final answer', turnId: 'turn-1' },
      ],
    );

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('treats turn.completed as a terminal task_complete mirror record', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-desktop-mirror-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-05-22T00:00:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'task_started',
            turn_id: 'turn-completed',
          },
        }),
        JSON.stringify({
          timestamp: '2026-05-22T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'streamed answer' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-05-22T00:00:02.000Z',
          type: 'event_msg',
          payload: {
            type: 'turn.completed',
            turnId: 'turn-completed',
            message: [
              { type: 'output_text', text: 'final answer' },
            ],
          },
        }),
        JSON.stringify({
          timestamp: '2026-05-22T00:00:03.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'next turn output' }],
          },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    const delta = readDesktopSessionMirrorRecordDeltaByFilePath(filePath, 0, fs.statSync(filePath).size);

    assert.deepEqual(delta.unknownKinds, []);
    assert.deepEqual(
      delta.records.map((record) => ({
        type: record.type,
        role: record.role,
        content: record.content,
        turnId: record.turnId,
      })),
      [
        { type: 'task_started', role: undefined, content: '', turnId: 'turn-completed' },
        { type: 'message', role: 'assistant', content: 'streamed answer', turnId: 'turn-completed' },
        { type: 'task_complete', role: 'assistant', content: 'final answer', turnId: 'turn-completed' },
        { type: 'message', role: 'assistant', content: 'next turn output', turnId: undefined },
      ],
    );

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('keeps task_complete records even when last_agent_message is empty', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-desktop-mirror-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-03-25T00:00:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            turn_id: 'turn-1',
            last_agent_message: '',
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const records = readDesktopSessionMirrorRecordStreamByFilePath(filePath);

    assert.deepEqual(records, [
      {
        signature: records[0]?.signature,
        type: 'task_complete',
        role: 'assistant',
        content: '',
        timestamp: '2026-03-25T00:00:00.000Z',
        turnId: 'turn-1',
      },
    ]);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('preserves markdown-style line breaks in mirror task_complete records', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-desktop-mirror-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-03-25T00:00:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            turn_id: 'turn-1',
            last_agent_message: '结论：\n1. 第一项\n2. 第二项',
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const records = readDesktopSessionMirrorRecordStreamByFilePath(filePath);

    assert.deepEqual(records, [
      {
        signature: records[0]?.signature,
        type: 'task_complete',
        role: 'assistant',
        content: '结论：\n1. 第一项\n2. 第二项',
        timestamp: '2026-03-25T00:00:00.000Z',
        turnId: 'turn-1',
      },
    ]);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('preserves line breaks in mirror user messages', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-desktop-mirror-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-03-25T00:00:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: '第一行\n第二行\n\n第三行',
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const records = readDesktopSessionMirrorRecordStreamByFilePath(filePath);

    assert.deepEqual(records, [
      {
        signature: records[0]?.signature,
        type: 'message',
        role: 'user',
        content: '第一行\n第二行\n\n第三行',
        timestamp: '2026-03-25T00:00:00.000Z',
      },
    ]);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('extracts text from structured function_call_output payloads without crashing', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-desktop-mirror-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-03-25T00:00:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'task_started',
            turn_id: 'turn-structured',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-25T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'call-structured',
            output: [
              { type: 'input_text', text: 'App terminal snapshot for this thread:' },
              { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
              { type: 'input_text', text: 'cwd: D:\\codex\\demo' },
            ],
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const records = readDesktopSessionMirrorRecordStreamByFilePath(filePath);

    assert.deepEqual(
      records.map((record) => ({
        type: record.type,
        content: record.content,
        turnId: record.turnId,
        toolId: record.toolId,
      })),
      [
        {
          type: 'task_started',
          content: '',
          turnId: 'turn-structured',
          toolId: undefined,
        },
        {
          type: 'tool_finished',
          content: 'App terminal snapshot for this thread: cwd: D:\\codex\\demo',
          turnId: 'turn-structured',
          toolId: 'call-structured',
        },
      ],
    );

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('extracts text from structured task_complete payloads', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-desktop-mirror-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-03-25T00:00:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            turn_id: 'turn-structured-complete',
            last_agent_message: [
              { type: 'output_text', text: '结论：' },
              { type: 'output_text', text: '- 第一项' },
              { type: 'output_text', text: '- 第二项' },
            ],
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const records = readDesktopSessionMirrorRecordStreamByFilePath(filePath);

    assert.deepEqual(records, [
      {
        signature: records[0]?.signature,
        type: 'task_complete',
        role: 'assistant',
        content: '结论：\n\n- 第一项\n\n- 第二项',
        timestamp: '2026-03-25T00:00:00.000Z',
        turnId: 'turn-structured-complete',
      },
    ]);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('parses reasoning, plan updates, and web search completion into mirror records', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-desktop-mirror-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-03-25T00:00:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'task_started',
            turn_id: 'turn-plan',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-25T00:00:00.500Z',
          type: 'event_msg',
          payload: {
            type: 'agent_reasoning',
            text: '先检查日志，再确认线程状态',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-25T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'update_plan',
            call_id: 'plan-1',
            arguments: JSON.stringify({
              plan: [
                { step: '检查日志', status: 'completed' },
                { step: '确认线程状态', status: 'in_progress' },
                { step: '补回归测试', status: 'pending' },
              ],
            }),
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-25T00:00:01.500Z',
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'plan-1',
            output: 'ignored output',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-25T00:00:02.000Z',
          type: 'event_msg',
          payload: {
            type: 'web_search_end',
            call_id: 'search-1',
            query: 'codex sdk latest',
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const records = readDesktopSessionMirrorRecordStreamByFilePath(filePath);

    assert.deepEqual(
      records.map((record) => ({
        type: record.type,
        content: record.content,
        turnId: record.turnId,
        toolId: record.toolId,
        toolName: record.toolName,
        tasks: record.tasks,
      })),
      [
        {
          type: 'task_started',
          content: '',
          turnId: 'turn-plan',
          toolId: undefined,
          toolName: undefined,
          tasks: undefined,
        },
        {
          type: 'reasoning',
          content: '先检查日志，再确认线程状态',
          turnId: 'turn-plan',
          toolId: undefined,
          toolName: undefined,
          tasks: undefined,
        },
        {
          type: 'plan_update',
          content: '',
          turnId: 'turn-plan',
          toolId: undefined,
          toolName: undefined,
          tasks: [
            { text: '检查日志', status: 'completed' },
            { text: '确认线程状态', status: 'in_progress' },
            { text: '补回归测试', status: 'pending' },
          ],
        },
        {
          type: 'tool_finished',
          content: 'codex sdk latest',
          turnId: 'turn-plan',
          toolId: 'search-1',
          toolName: 'Web Search',
          tasks: undefined,
        },
      ],
    );

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('parses current Codex desktop tool and reasoning events into mirror records', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-desktop-mirror-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-05-14T00:00:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'task_started',
            turn_id: 'turn-current',
          },
        }),
        JSON.stringify({
          timestamp: '2026-05-14T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'reasoning',
            summary: [{ type: 'summary_text', text: '先检查新版 Codex 事件格式' }],
            content: null,
          },
        }),
        JSON.stringify({
          timestamp: '2026-05-14T00:00:02.000Z',
          type: 'event_msg',
          payload: {
            type: 'exec_command_end',
            call_id: 'call-shell',
            turn_id: 'turn-current',
            command: ['pwsh', '-Command', 'npm test'],
            aggregated_output: 'tests passed',
            exit_code: 0,
            status: 'completed',
          },
        }),
        JSON.stringify({
          timestamp: '2026-05-14T00:00:03.000Z',
          type: 'event_msg',
          payload: {
            type: 'patch_apply_end',
            call_id: 'call-patch',
            turn_id: 'turn-current',
            success: true,
            status: 'completed',
            changes: {
              'D:\\codex\\Claude-to-IM-skill\\src\\desktop-sessions.ts': {
                type: 'update',
              },
            },
          },
        }),
        JSON.stringify({
          timestamp: '2026-05-14T00:00:04.000Z',
          type: 'response_item',
          payload: {
            type: 'tool_search_call',
            call_id: 'call-tool-search',
            status: 'completed',
            execution: 'client',
            arguments: { query: 'browser inspect' },
          },
        }),
        JSON.stringify({
          timestamp: '2026-05-14T00:00:05.000Z',
          type: 'response_item',
          payload: {
            type: 'tool_search_output',
            call_id: 'call-tool-search',
            status: 'completed',
            execution: 'client',
            tools: [{ name: 'mcp__playwright__', tools: [{ name: 'browser_snapshot' }] }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-05-14T00:00:06.000Z',
          type: 'event_msg',
          payload: {
            type: 'dynamic_tool_call_request',
            callId: 'call-dynamic',
            turnId: 'turn-current',
            tool: 'read_thread_terminal',
            arguments: {},
          },
        }),
        JSON.stringify({
          timestamp: '2026-05-14T00:00:07.000Z',
          type: 'event_msg',
          payload: {
            type: 'dynamic_tool_call_response',
            call_id: 'call-dynamic',
            turn_id: 'turn-current',
            tool: 'read_thread_terminal',
            content_items: [{ type: 'inputText', text: 'terminal output' }],
            success: false,
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const records = readDesktopSessionMirrorRecordStreamByFilePath(filePath);

    assert.deepEqual(
      records.map((record) => ({
        type: record.type,
        content: record.content,
        turnId: record.turnId,
        toolId: record.toolId,
        toolName: record.toolName,
        isError: record.isError,
      })),
      [
        {
          type: 'task_started',
          content: '',
          turnId: 'turn-current',
          toolId: undefined,
          toolName: undefined,
          isError: undefined,
        },
        {
          type: 'reasoning',
          content: '先检查新版 Codex 事件格式',
          turnId: 'turn-current',
          toolId: undefined,
          toolName: undefined,
          isError: undefined,
        },
        {
          type: 'tool_finished',
          content: 'tests passed',
          turnId: 'turn-current',
          toolId: 'call-shell',
          toolName: 'Bash',
          isError: false,
        },
        {
          type: 'tool_finished',
          content: 'update: D:\\codex\\Claude-to-IM-skill\\src\\desktop-sessions.ts',
          turnId: 'turn-current',
          toolId: 'call-patch',
          toolName: 'apply_patch',
          isError: false,
        },
        {
          type: 'tool_started',
          content: '',
          turnId: 'turn-current',
          toolId: 'call-tool-search',
          toolName: 'tool_search',
          isError: undefined,
        },
        {
          type: 'tool_finished',
          content: 'Found 1 tools: mcp__playwright__',
          turnId: 'turn-current',
          toolId: 'call-tool-search',
          toolName: 'tool_search',
          isError: false,
        },
        {
          type: 'tool_started',
          content: '',
          turnId: 'turn-current',
          toolId: 'call-dynamic',
          toolName: 'read_thread_terminal',
          isError: undefined,
        },
        {
          type: 'tool_finished',
          content: 'terminal output',
          turnId: 'turn-current',
          toolId: 'call-dynamic',
          toolName: 'read_thread_terminal',
          isError: true,
        },
      ],
    );

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('preserves namespaced desktop tool names', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-desktop-mirror-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-05-14T00:00:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'task_started',
            turn_id: 'turn-tool-namespace',
          },
        }),
        JSON.stringify({
          timestamp: '2026-05-14T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            namespace: 'mcp__playwright__',
            name: 'browser_resize',
            call_id: 'call-namespaced',
            arguments: '{"width":1280,"height":720}',
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const records = readDesktopSessionMirrorRecordStreamByFilePath(filePath);

    assert.deepEqual(
      records.map((record) => ({
        type: record.type,
        toolId: record.toolId,
        toolName: record.toolName,
      })),
      [
        {
          type: 'task_started',
          toolId: undefined,
          toolName: undefined,
        },
        {
          type: 'tool_started',
          toolId: 'call-namespaced',
          toolName: 'mcp__playwright__browser_resize',
        },
      ],
    );

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('falls back to reasoning content when summary is empty', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-desktop-mirror-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-05-14T00:00:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'task_started',
            turn_id: 'turn-reasoning-fallback',
          },
        }),
        JSON.stringify({
          timestamp: '2026-05-14T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'reasoning',
            summary: [],
            content: [{ type: 'summary_text', text: 'fallback reasoning content' }],
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const records = readDesktopSessionMirrorRecordStreamByFilePath(filePath);

    assert.deepEqual(
      records.map((record) => ({ type: record.type, content: record.content })),
      [
        { type: 'task_started', content: '' },
        { type: 'reasoning', content: 'fallback reasoning content' },
      ],
    );

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('parses custom tool output and clears turn context after turn_aborted', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-desktop-mirror-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-03-25T00:00:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'task_started',
            turn_id: 'turn-abort',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-25T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            name: 'shell_command',
            call_id: 'custom-1',
            input: '{"command":"dir"}',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-25T00:00:01.500Z',
          type: 'response_item',
          payload: {
            type: 'custom_tool_call_output',
            call_id: 'custom-1',
            output: JSON.stringify({ output: 'Exit code: 0' }),
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-25T00:00:02.000Z',
          type: 'event_msg',
          payload: {
            type: 'turn_aborted',
            turn_id: 'turn-abort',
            reason: 'user interrupted',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-25T00:00:03.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'next turn output' }],
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const records = readDesktopSessionMirrorRecordStreamByFilePath(filePath);

    assert.deepEqual(
      records.map((record) => ({
        type: record.type,
        content: record.content,
        turnId: record.turnId,
        toolId: record.toolId,
        toolName: record.toolName,
      })),
      [
        {
          type: 'task_started',
          content: '',
          turnId: 'turn-abort',
          toolId: undefined,
          toolName: undefined,
        },
        {
          type: 'tool_started',
          content: '',
          turnId: 'turn-abort',
          toolId: 'custom-1',
          toolName: 'shell_command',
        },
        {
          type: 'tool_finished',
          content: 'Exit code: 0',
          turnId: 'turn-abort',
          toolId: 'custom-1',
          toolName: undefined,
        },
        {
          type: 'task_aborted',
          content: 'user interrupted',
          turnId: 'turn-abort',
          toolId: undefined,
          toolName: undefined,
        },
        {
          type: 'message',
          content: 'next turn output',
          turnId: undefined,
          toolId: undefined,
          toolName: undefined,
        },
      ],
    );

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('preserves update_plan special call state across incremental mirror reads', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-desktop-mirror-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    const firstChunk = [
      JSON.stringify({
        timestamp: '2026-03-25T00:00:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: 'turn-plan-split',
        },
      }),
      JSON.stringify({
        timestamp: '2026-03-25T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'update_plan',
          call_id: 'plan-split-1',
          arguments: JSON.stringify({
            plan: [
              { step: '检查日志', status: 'in_progress' },
              { step: '确认线程状态', status: 'pending' },
            ],
          }),
        },
      }),
    ].join('\n');
    fs.writeFileSync(filePath, `${firstChunk}\n`, 'utf-8');

    const firstDelta = readDesktopSessionMirrorRecordDeltaByFilePath(filePath, 0, fs.statSync(filePath).size);
    assert.deepEqual(firstDelta.records.map((record) => record.type), ['task_started', 'plan_update']);
    assert.equal(firstDelta.nextTurnId, 'turn-plan-split');
    assert.deepEqual(firstDelta.nextSpecialCallIds, ['plan-split-1']);
    assert.deepEqual(firstDelta.unknownKinds, []);

    fs.appendFileSync(filePath, [
      JSON.stringify({
        timestamp: '2026-03-25T00:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'plan-split-1',
          output: 'ignored output',
        },
      }),
      JSON.stringify({
        timestamp: '2026-03-25T00:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '继续执行' }],
        },
      }),
      '',
    ].join('\n'), 'utf-8');

    const secondDelta = readDesktopSessionMirrorRecordDeltaByFilePath(
      filePath,
      firstDelta.nextOffset,
      fs.statSync(filePath).size,
      firstDelta.trailingText,
      firstDelta.nextTurnId,
      firstDelta.nextSpecialCallIds,
    );

    assert.deepEqual(
      secondDelta.records.map((record) => ({ type: record.type, content: record.content })),
      [{ type: 'message', content: '继续执行' }],
    );
    assert.deepEqual(secondDelta.nextSpecialCallIds, []);
    assert.deepEqual(secondDelta.unknownKinds, []);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('surfaces unknown desktop mirror event kinds for diagnostics without crashing', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-desktop-mirror-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-03-25T00:00:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'approval_request_started',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-25T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'approval_request',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-25T00:00:02.000Z',
          type: 'future_top_level_record',
          payload: {},
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    const delta = readDesktopSessionMirrorRecordDeltaByFilePath(filePath, 0, fs.statSync(filePath).size);
    assert.deepEqual(delta.records, []);
    assert.deepEqual(delta.unknownKinds.sort(), [
      'event_msg:approval_request_started',
      'response_item:approval_request',
      'top_level:future_top_level_record',
    ]);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('ignores known Codex desktop bookkeeping events without reporting unknown kinds', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-desktop-mirror-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-05-14T00:00:00.000Z',
          type: 'event_msg',
          payload: { type: 'token_count', info: {}, rate_limits: {} },
        }),
        JSON.stringify({
          timestamp: '2026-05-14T00:00:01.000Z',
          type: 'event_msg',
          payload: { type: 'context_compacted' },
        }),
        JSON.stringify({
          timestamp: '2026-05-14T00:00:02.000Z',
          type: 'event_msg',
          payload: { type: 'thread_name_updated', thread_name: '新标题' },
        }),
        JSON.stringify({
          timestamp: '2026-05-14T00:00:03.000Z',
          type: 'event_msg',
          payload: { type: 'thread_rolled_back', num_turns: 1 },
        }),
        JSON.stringify({
          timestamp: '2026-05-14T00:00:03.500Z',
          type: 'event_msg',
          payload: { type: 'thread_goal_updated' },
        }),
        JSON.stringify({
          timestamp: '2026-05-14T00:00:04.000Z',
          type: 'response_item',
          payload: { type: 'web_search_call', status: 'completed' },
        }),
        JSON.stringify({
          timestamp: '2026-05-14T00:00:05.000Z',
          type: 'event_msg',
          payload: { type: 'thread_settings_applied' },
        }),
        JSON.stringify({
          timestamp: '2026-05-14T00:00:06.000Z',
          type: 'response_item',
          payload: {
            type: 'image_generation_call',
            id: 'ig-ignore',
            status: 'generating',
            result: 'iVBORw0KGgoAAAANSUhEUgAA',
            revised_prompt: 'ignored duplicate image payload',
          },
        }),
        JSON.stringify({
          timestamp: '2026-05-14T00:00:07.000Z',
          type: 'session_meta',
          payload: { id: 'thread-1' },
        }),
        JSON.stringify({
          timestamp: '2026-05-14T00:00:08.000Z',
          type: 'world_state',
          payload: { cwd: 'D:\\codex\\project' },
        }),
        JSON.stringify({
          timestamp: '2026-05-14T00:00:09.000Z',
          type: 'compacted',
          payload: { replacement_history: [] },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    const delta = readDesktopSessionMirrorRecordDeltaByFilePath(filePath, 0, fs.statSync(filePath).size);
    assert.deepEqual(delta.records, []);
    assert.deepEqual(delta.unknownKinds, []);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('uses response_item user messages as a fallback without duplicating event_msg user messages', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-desktop-mirror-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    const userText = '只应镜像一次';
    fs.writeFileSync(filePath, [
      JSON.stringify({
        timestamp: '2026-05-14T00:00:00.000Z',
        type: 'turn_context',
        payload: { turn_id: 'turn-user-fallback' },
      }),
      JSON.stringify({
        timestamp: '2026-05-14T00:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: userText },
      }),
      JSON.stringify({
        timestamp: '2026-05-14T00:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: userText }],
        },
      }),
    ].join('\n') + '\n', 'utf8');

    const delta = readDesktopSessionMirrorRecordDeltaByFilePath(filePath, 0, fs.statSync(filePath).size);
    assert.deepEqual(delta.records.map((record) => ({ role: record.role, content: record.content })), [
      { role: 'user', content: userText },
    ]);
    assert.deepEqual(delta.unknownKinds, []);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('ignores injected environment context before the real desktop user prompt', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-desktop-mirror-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(filePath, [
      JSON.stringify({
        timestamp: '2026-07-20T04:00:00.000Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-with-context' },
      }),
      JSON.stringify({
        timestamp: '2026-07-20T04:00:00.001Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: '<environment_context>\n  <cwd>D:\\codex\\project</cwd>\n</environment_context>',
          }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-07-20T04:00:00.002Z',
        type: 'world_state',
        payload: { cwd: 'D:\\codex\\project' },
      }),
      JSON.stringify({
        timestamp: '2026-07-20T04:00:00.003Z',
        type: 'turn_context',
        payload: { turn_id: 'turn-with-context' },
      }),
      JSON.stringify({
        timestamp: '2026-07-20T04:00:00.004Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '好的，开始吧' }],
        },
      }),
    ].join('\n') + '\n', 'utf8');

    const delta = readDesktopSessionMirrorRecordDeltaByFilePath(filePath, 0, fs.statSync(filePath).size);

    assert.deepEqual(
      delta.records.map((record) => ({ type: record.type, role: record.role, content: record.content })),
      [
        { type: 'task_started', role: undefined, content: '' },
        { type: 'message', role: 'user', content: '好的，开始吧' },
      ],
    );
    assert.deepEqual(delta.unknownKinds, []);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('parses Codex desktop image generation completion without mirroring base64 payloads', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-desktop-mirror-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-07-06T09:18:32.624Z',
          type: 'event_msg',
          payload: {
            type: 'image_generation_end',
            call_id: 'ig_0ac723545eab6ba8016a4b7272b990819aadfa79ffbc080341',
            status: 'generating',
            saved_path: 'C:\\Users\\zhangle\\.codex\\generated_images\\thread\\ig_0ac723545eab6ba8016a4b7272b990819aadfa79ffbc080341.png',
            revised_prompt: 'Use case: ui-mockup',
            result: 'iVBORw0KGgoAAAANSUhEUgAA'.repeat(200),
          },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    const delta = readDesktopSessionMirrorRecordDeltaByFilePath(filePath, 0, fs.statSync(filePath).size);
    assert.deepEqual(delta.unknownKinds, []);
    assert.equal(delta.records.length, 1);
    assert.deepEqual(
      {
        type: delta.records[0]?.type,
        content: delta.records[0]?.content,
        toolId: delta.records[0]?.toolId,
        toolName: delta.records[0]?.toolName,
        isError: delta.records[0]?.isError,
      },
      {
        type: 'tool_finished',
        content: 'Saved: C:\\Users\\zhangle\\.codex\\generated_images\\thread\\ig_0ac723545eab6ba8016a4b7272b990819aadfa79ffbc080341.png\n\nPrompt: Use case: ui-mockup',
        toolId: 'ig_0ac723545eab6ba8016a4b7272b990819aadfa79ffbc080341',
        toolName: 'image_generation',
        isError: false,
      },
    );
    assert.equal(delta.records[0]?.content.includes('iVBOR'), false);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('reads appended mirror records and preserves trailing partial text', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-desktop-mirror-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    const firstLine = JSON.stringify({
      timestamp: '2026-03-25T00:00:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'task_started',
        turn_id: 'turn-1',
      },
    });
    const secondLine = JSON.stringify({
      timestamp: '2026-03-25T00:00:02.000Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'turn-1',
        last_agent_message: 'final answer',
      },
    });
    fs.writeFileSync(filePath, `${firstLine}\n${secondLine.slice(0, 48)}`, 'utf-8');

    const firstDelta = readDesktopSessionMirrorRecordDeltaByFilePath(filePath, 0, fs.statSync(filePath).size);
    assert.deepEqual(
      firstDelta.records.map((record) => record.type),
      ['task_started'],
    );
    assert.equal(firstDelta.trailingText, '');
    assert.equal(firstDelta.nextOffset, Buffer.byteLength(`${firstLine}\n`, 'utf8'));

    fs.appendFileSync(filePath, `${secondLine.slice(48)}\n`, 'utf-8');
    const secondDelta = readDesktopSessionMirrorRecordDeltaByFilePath(
      filePath,
      firstDelta.nextOffset,
      fs.statSync(filePath).size,
      firstDelta.trailingText,
    );

    assert.deepEqual(
      secondDelta.records.map((record) => ({ type: record.type, content: record.content })),
      [{ type: 'task_complete', content: 'final answer' }],
    );
    assert.equal(secondDelta.trailingText, '');

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('advances past a JSONL record larger than the configured mirror read chunk', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-desktop-mirror-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    const largeLine = JSON.stringify({
      timestamp: '2026-03-25T00:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        call_id: 'large-output',
        output: 'x'.repeat(4_000),
      },
    });
    const finalLine = JSON.stringify({
      timestamp: '2026-03-25T00:00:01.000Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'turn-large-output',
        last_agent_message: 'done',
      },
    });
    fs.writeFileSync(filePath, `${largeLine}\n${finalLine}\n`, 'utf8');

    const first = readDesktopSessionMirrorRecordDeltaByFilePath(
      filePath,
      0,
      fs.statSync(filePath).size,
      '',
      null,
      [],
      { maxBytes: 128 },
    );
    assert.ok(first.nextOffset > 128);
    assert.equal(first.records[0]?.type, 'tool_finished');
    assert.ok(first.nextOffset < fs.statSync(filePath).size);

    const second = readDesktopSessionMirrorRecordDeltaByFilePath(
      filePath,
      first.nextOffset,
      fs.statSync(filePath).size,
      first.trailingText,
      first.nextTurnId,
      first.nextSpecialCallIds,
      { maxBytes: 128 },
    );
    assert.equal(second.records.at(-1)?.content, 'done');
    assert.equal(second.nextOffset, fs.statSync(filePath).size);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('does not corrupt a multibyte character split across incremental reads', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-desktop-mirror-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    const firstLine = JSON.stringify({
      timestamp: '2026-03-25T00:00:00.000Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-unicode' },
    });
    const secondLine = JSON.stringify({
      timestamp: '2026-03-25T00:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn-unicode', last_agent_message: '最终回复' },
    });
    const fullBuffer = Buffer.from(`${firstLine}\n${secondLine}\n`, 'utf8');
    const unicodeStart = fullBuffer.indexOf(Buffer.from('最终回复', 'utf8'));
    const splitOffset = unicodeStart + 1;
    fs.writeFileSync(filePath, fullBuffer.subarray(0, splitOffset));

    const firstDelta = readDesktopSessionMirrorRecordDeltaByFilePath(filePath, 0, splitOffset);
    assert.deepEqual(firstDelta.records.map((record) => record.type), ['task_started']);
    assert.equal(firstDelta.nextOffset, Buffer.byteLength(`${firstLine}\n`, 'utf8'));

    fs.appendFileSync(filePath, fullBuffer.subarray(splitOffset));
    const secondDelta = readDesktopSessionMirrorRecordDeltaByFilePath(
      filePath,
      firstDelta.nextOffset,
      fs.statSync(filePath).size,
      firstDelta.trailingText,
      firstDelta.nextTurnId,
      firstDelta.nextSpecialCallIds,
    );
    assert.equal(secondDelta.records.at(-1)?.content, '最终回复');
    assert.doesNotMatch(secondDelta.records.at(-1)?.content || '', /�/);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('prefers response item metadata turn ids over stale turn context', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-desktop-turn-metadata-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(filePath, [
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'stale-turn' } }),
      JSON.stringify({
        timestamp: '2026-07-20T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'current answer' }],
          internal_chat_message_metadata_passthrough: { turn_id: 'current-turn' },
        },
      }),
    ].join('\n') + '\n', 'utf8');

    try {
      const records = readDesktopSessionMirrorRecordStreamByFilePath(filePath);
      assert.equal(records[0]?.turnId, 'current-turn');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
