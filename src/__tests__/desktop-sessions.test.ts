import './test-setup.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  listDesktopSessions,
  readDesktopSessionEventDeltaByFilePath,
  readDesktopSessionEventStreamByFilePath,
  readDesktopSessionMirrorRecordDeltaByFilePath,
  readDesktopSessionMirrorRecordStreamByFilePath,
} from '../desktop-sessions.js';

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

  it('includes freshly created desktop threads that have reached session_index before the state db catches up', () => {
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
    assert.equal(firstDelta.trailingText, secondLine.slice(0, 40));

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
    assert.equal(firstDelta.trailingText, secondLine.slice(0, 48));

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
});
