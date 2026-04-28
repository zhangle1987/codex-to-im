import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  assembleDesktopFinalResponse,
  assembleSdkFinalResponse,
  mergeFinalResponses,
  stripFinalOnlyBlocksForStreaming,
} from '../lib/bridge/turns/response-assembler.js';

describe('response-assembler', () => {
  it('strips final-only send blocks and deduplicates attachments', () => {
    const response = assembleSdkFinalResponse({
      text: [
        '最终说明',
        '',
        '<cti-send>{"type":"image","path":"D:\\\\work\\\\out.png","caption":"图"}</cti-send>',
      ].join('\n'),
      attachments: [
        {
          kind: 'image',
          path: 'D:\\work\\out.png',
          caption: '图',
        },
      ],
    });

    assert.equal(response.text, '最终说明');
    assert.equal(response.source, 'sdk_result');
    assert.deepEqual(response.attachments, [
      {
        kind: 'image',
        path: 'D:\\work\\out.png',
        caption: '图',
      },
    ]);
  });

  it('uses desktop final text as primary while preserving SDK attachments', () => {
    const sdk = assembleSdkFinalResponse({
      text: 'SDK 回复',
      attachments: [{ kind: 'file', path: 'D:\\work\\sdk.txt' }],
    });
    const desktop = assembleDesktopFinalResponse({
      text: [
        '桌面最终回复',
        '<cti-send>{"type":"image","path":"D:\\\\work\\\\desktop.png"}</cti-send>',
      ].join('\n'),
    });

    const merged = mergeFinalResponses(desktop, sdk);

    assert.equal(merged.text, '桌面最终回复');
    assert.equal(merged.source, 'desktop_task_complete');
    assert.deepEqual(merged.attachments, [
      { kind: 'file', path: 'D:\\work\\sdk.txt' },
      {
        kind: 'image',
        path: 'D:\\work\\desktop.png',
        caption: undefined,
        name: undefined,
      },
    ]);
  });

  it('strips complete and incomplete final-only blocks from streaming text', () => {
    assert.equal(
      stripFinalOnlyBlocksForStreaming([
        '正文',
        '<cti-send>{"type":"file","path":"D:\\\\a.txt"}</cti-send>',
        '继续',
        '<cti-send>{"type":"file"',
      ].join('\n')),
      '正文\n\n继续',
    );
  });
});
