import './test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';

import {
  assertTrustedMutationRequest,
  HttpRequestError,
  readJsonBody,
} from '../ui-http-security.js';

function makeRequest(
  body: string,
  headers: Record<string, string> = {},
): IncomingMessage {
  const request = Readable.from(body ? [Buffer.from(body)] : []) as IncomingMessage;
  request.headers = headers;
  return request;
}

describe('UI HTTP security', () => {
  it('accepts same-origin mutations and rejects cross-origin browser requests', () => {
    assert.doesNotThrow(() => assertTrustedMutationRequest({
      method: 'POST',
      headers: {
        host: '127.0.0.1:4781',
        origin: 'http://127.0.0.1:4781',
        'sec-fetch-site': 'same-origin',
      },
    }));

    assert.throws(() => assertTrustedMutationRequest({
      method: 'POST',
      headers: {
        host: '127.0.0.1:4781',
        origin: 'https://attacker.example',
        'sec-fetch-site': 'cross-site',
      },
    }), (error: unknown) => error instanceof HttpRequestError && error.statusCode === 403);
  });

  it('allows origin-less API clients while still rejecting an explicit mismatched origin', () => {
    assert.doesNotThrow(() => assertTrustedMutationRequest({
      method: 'POST',
      headers: { host: '127.0.0.1:4781' },
    }));
    assert.throws(() => assertTrustedMutationRequest({
      method: 'POST',
      headers: {
        host: '127.0.0.1:4781',
        origin: 'http://localhost:9999',
      },
    }), /非同源/);
  });

  it('parses bounded JSON bodies and reports client errors with specific status codes', async () => {
    const parsed = await readJsonBody<{ ok: boolean }>(makeRequest(
      '{"ok":true}',
      { 'content-type': 'application/json; charset=utf-8' },
    ));
    assert.deepEqual(parsed, { ok: true });

    await assert.rejects(
      readJsonBody(makeRequest('not-json', { 'content-type': 'application/json' })),
      (error: unknown) => error instanceof HttpRequestError && error.statusCode === 400,
    );
    await assert.rejects(
      readJsonBody(makeRequest('{"ok":true}', { 'content-type': 'text/plain' })),
      (error: unknown) => error instanceof HttpRequestError && error.statusCode === 415,
    );
    await assert.rejects(
      readJsonBody(makeRequest('12345', { 'content-type': 'application/json' }), 4),
      (error: unknown) => error instanceof HttpRequestError && error.statusCode === 413,
    );
  });
});
