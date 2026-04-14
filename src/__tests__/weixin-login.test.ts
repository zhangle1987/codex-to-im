import './test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildQrHtml, buildWeixinLoginPopupHtml } from '../weixin-login.js';

describe('weixin-login HTML', () => {
  it('embeds inline QR markup without remote CDN scripts', () => {
    const html = buildQrHtml('<svg viewBox="0 0 10 10"><rect width="10" height="10" /></svg>');

    assert.match(html, /<svg viewBox="0 0 10 10">/);
    assert.ok(!html.includes('cdn.jsdelivr.net'));
    assert.ok(!html.includes('<script'));
  });

  it('builds a popup page that polls session status from the UI server', () => {
    const html = buildWeixinLoginPopupHtml('session-123');

    assert.match(html, /\/api\/channels\/weixin-login\//);
    assert.match(html, /session-123/);
    assert.ok(!html.includes('cdn.jsdelivr.net'));
    assert.ok(!html.includes('<script src='));
  });
});
