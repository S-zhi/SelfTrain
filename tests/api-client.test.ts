import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, api } from '../src/api';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('API 客户端错误', () => {
  it('保留 HTTP 状态码，让会话冲突可以被区分处理', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: '当前题已在另一个页面更新。', details: [] }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    )));

    await expect(api.active()).rejects.toMatchObject({
      name: 'ApiRequestError',
      message: '当前题已在另一个页面更新。',
      status: 409,
    });
  });

  it('本地校验错误没有 HTTP 状态码', () => {
    const error = new ApiRequestError('输入无效。');
    expect(error.status).toBeNull();
  });
});
