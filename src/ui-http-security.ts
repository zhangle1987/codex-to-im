import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';

export const DEFAULT_JSON_BODY_LIMIT_BYTES = 1024 * 1024;

export class HttpRequestError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpRequestError';
  }
}

type RequestMetadata = {
  method?: string;
  headers: IncomingHttpHeaders;
};

export function isMutationMethod(method: string | undefined): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

function getExpectedOrigin(headers: IncomingHttpHeaders): string {
  const host = headers.host?.trim();
  if (!host) throw new HttpRequestError(400, '请求缺少 Host header。');
  return `http://${host}`;
}

export function assertTrustedMutationRequest(request: RequestMetadata): void {
  if (!isMutationMethod(request.method)) return;

  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite === 'cross-site') {
    throw new HttpRequestError(403, '已拒绝跨站管理请求。');
  }

  const origin = request.headers.origin;
  if (!origin) return;
  if (origin === 'null') {
    throw new HttpRequestError(403, '已拒绝来源不明的管理请求。');
  }

  let normalizedOrigin: string;
  try {
    normalizedOrigin = new URL(origin).origin;
  } catch {
    throw new HttpRequestError(403, '请求 Origin 无效。');
  }
  if (normalizedOrigin !== getExpectedOrigin(request.headers)) {
    throw new HttpRequestError(403, '已拒绝非同源管理请求。');
  }
}

export async function readJsonBody<T>(
  request: IncomingMessage,
  maxBytes = DEFAULT_JSON_BODY_LIMIT_BYTES,
): Promise<T> {
  const boundedMaxBytes = Math.max(1, maxBytes);
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > boundedMaxBytes) {
    throw new HttpRequestError(413, `请求体超过 ${boundedMaxBytes} 字节限制。`);
  }

  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    receivedBytes += buffer.length;
    if (receivedBytes > boundedMaxBytes) {
      request.resume();
      throw new HttpRequestError(413, `请求体超过 ${boundedMaxBytes} 字节限制。`);
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) return {} as T;

  const contentType = request.headers['content-type'] || '';
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new HttpRequestError(415, '请求体必须使用 application/json。');
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new HttpRequestError(400, '请求体不是有效 JSON。');
  }
}
