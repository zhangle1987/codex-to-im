import './test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseOutboundArtifacts,
  stripOutboundArtifactBlocksForStreaming,
  supportsOutboundArtifacts,
} from '../lib/bridge/outbound-artifacts.js';

describe('outbound-artifacts', () => {
  it('extracts attachments and strips send blocks from final text', () => {
    const parsed = parseOutboundArtifacts([
      '这里是说明文字。',
      '',
      '<cti-send>',
      '{"type":"image","path":"D:\\\\work\\\\demo.png","caption":"结果图"}',
      '</cti-send>',
    ].join('\n'));

    assert.equal(parsed.cleanText, '这里是说明文字。');
    assert.deepEqual(parsed.attachments, [
      {
        kind: 'image',
        path: 'D:\\work\\demo.png',
        caption: '结果图',
        name: undefined,
      },
    ]);
    assert.deepEqual(parsed.errors, []);
  });

  it('supports batched item payloads', () => {
    const parsed = parseOutboundArtifacts(
      '<cti-send>{"items":[{"type":"image","path":"D:\\\\a.png"},{"type":"file","path":"D:\\\\report.pdf"}]}</cti-send>',
    );

    assert.equal(parsed.cleanText, '');
    assert.deepEqual(parsed.attachments, [
      {
        kind: 'image',
        path: 'D:\\a.png',
        caption: undefined,
        name: undefined,
      },
      {
        kind: 'file',
        path: 'D:\\report.pdf',
        caption: undefined,
        name: undefined,
      },
    ]);
  });

  it('hides completed and incomplete send blocks from streaming text', () => {
    const full = stripOutboundArtifactBlocksForStreaming([
      '先说明一下结果。',
      '',
      '<cti-send>{"type":"image","path":"D:\\\\work\\\\demo.png"}</cti-send>',
      '',
      '补充说明',
      '',
      '<cti-send>{"type":"file","path":"D:\\\\work\\\\report.pdf"',
    ].join('\n'));

    assert.equal(full, '先说明一下结果。\n\n补充说明');
  });

  it('tracks which channels support outbound artifacts', () => {
    assert.equal(supportsOutboundArtifacts('feishu'), true);
    assert.equal(supportsOutboundArtifacts('weixin'), false);
  });
});
