import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildLocalAttachmentPromptSupplement } from '../lib/bridge/conversation-engine.js';

describe('buildLocalAttachmentPromptSupplement', () => {
  it('returns an empty string when only images are present', () => {
    const result = buildLocalAttachmentPromptSupplement([
      {
        id: 'img-1',
        name: 'screenshot.png',
        type: 'image/png',
        size: 2048,
        filePath: 'D:\\work\\.codepilot-uploads\\screenshot.png',
      },
    ]);

    assert.equal(result, '');
  });

  it('includes local file paths for non-image attachments', () => {
    const result = buildLocalAttachmentPromptSupplement([
      {
        id: 'pdf-1',
        name: 'report.pdf',
        type: 'application/pdf',
        size: 40960,
        filePath: 'D:\\work\\.codepilot-uploads\\report.pdf',
      },
      {
        id: 'video-1',
        name: 'demo.mp4',
        type: 'video/mp4',
        size: 5 * 1024 * 1024,
        filePath: 'D:\\work\\.codepilot-uploads\\demo.mp4',
      },
    ]);

    assert.match(result, /Attached local files:/);
    assert.match(result, /report\.pdf/);
    assert.match(result, /application\/pdf/);
    assert.match(result, /D:\\work\\\.codepilot-uploads\\report\.pdf/);
    assert.match(result, /demo\.mp4/);
    assert.match(result, /video\/mp4/);
    assert.match(result, /extract frames or audio only when needed/i);
  });
});
