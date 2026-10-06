import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../server/db';
import { openDatabase } from '../server/db';
import { buildServer } from '../server/routes';
import type { SessionView } from '../shared/api';

const jsonl = readFileSync(new URL('../examples/go-syntax.jsonl', import.meta.url), 'utf8');
const base = 1_760_000_000_000;

describe('本地 API', () => {
  let db: Db;
  let app: FastifyInstance;
  let now: number;

  beforeEach(async () => {
    db = openDatabase(':memory:');
    now = base;
    app = await buildServer(db, () => now);
  });
  afterEach(async () => {
    await app.close();
    db.close();
  });

  async function post(url: string, payload: unknown = {}) {
    return await app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
  }

  it('导入 30 道 Go 题、逐题开始计时；答前不泄露正确答案', async () => {
    const imported = await post('/api/questions/import', { jsonl });
    expect(imported.statusCode).toBe(200);
    expect(imported.json()).toMatchObject({ imported: 30, skipped: 0 });

    const started = await post('/api/sessions');
    expect(started.statusCode).toBe(200);
    const session = started.json().session as SessionView;
    expect(session.phase).toBe('question');
    expect(session.total).toBe(30);
    expect(JSON.stringify(session)).not.toContain('explanation');
    expect(JSON.stringify(session)).not.toContain('correctLabel');

    now += 1000;
    const resumed = (await post('/api/sessions/active/view')).json().session as SessionView;
    expect(resumed.phase === 'question' && resumed.question.deadlineAt)
      .toBe(session.phase === 'question' && session.question.deadlineAt);
    const answer = await post(`/api/sessions/${session.id}/answer`, { selectedLabel: 'A', position: session.position });
    expect(answer.statusCode).toBe(200);
    expect(answer.json().session.phase).toBe('feedback');
    expect(answer.json().session.feedback.correctLabel).toMatch(/^[A-D]$/);
    expect((await post(`/api/sessions/${session.id}/answer`, { selectedLabel: 'D', position: session.position })).json())
      .toEqual(answer.json());
  });

  it('超时后不能补交，错误来源和非 JSON 写请求被拒绝', async () => {
    await post('/api/questions/import', { jsonl });
    const session = (await post('/api/sessions')).json().session as SessionView;
    now += 3_600_001;
    const late = await post(`/api/sessions/${session.id}/answer`, { selectedLabel: 'A', position: session.position });
    expect(late.json().session.feedback.status).toBe('timeout');
    expect((await app.inject({ method: 'POST', url: '/api/sessions',
      headers: { origin: 'https://other.example', 'content-type': 'application/json' }, payload: '{}' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/sessions',
      headers: { 'content-type': 'text/plain' }, payload: '{}' })).statusCode).toBe(415);
  });

  it('旧题位置和外部 Host 不会被接受', async () => {
    await post('/api/questions/import', { jsonl });
    const session = (await post('/api/sessions')).json().session as SessionView;
    await post(`/api/sessions/${session.id}/answer`, { selectedLabel: 'A', position: 1 });
    await post(`/api/sessions/${session.id}/next`, { position: 1 });
    const stale = await post(`/api/sessions/${session.id}/answer`, { selectedLabel: 'B', position: 1 });
    expect(stale.statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: '/api/backup', headers: { host: 'external.example' } })).statusCode).toBe(403);
  });

  it('备份下载与恢复后题库和设置不丢失', async () => {
    await post('/api/questions/import', { jsonl });
    const backup = (await app.inject({ method: 'GET', url: '/api/backup' })).json();
    const settings = await app.inject({ method: 'PUT', url: '/api/settings',
      headers: { 'content-type': 'application/json' }, payload: { intervalHours: 48 } });
    expect(settings.statusCode).toBe(200);
    const restored = await post('/api/backup/restore', backup);
    expect(restored.statusCode).toBe(200);
    const stats = (await app.inject({ method: 'GET', url: '/api/stats' })).json();
    expect(stats.questions.total).toBe(30);
    expect(stats.intervalHours).toBe(24);
  });
});
