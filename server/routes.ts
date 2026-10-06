import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { resolve } from 'node:path';
import { z } from 'zod';
import { apiPort } from './config';
import type { Db } from './db';
import { exportBackup, restoreBackup } from './domain/backup';
import { DomainError } from './domain/errors';
import { importQuestions } from './domain/import';
import { startSession } from './domain/scheduler';
import { endSession, getActiveView, getSessionSummary, nextQuestion, submitAnswer } from './domain/session';
import { getStats } from './domain/stats';

const filterSchema = z.object({
  language: z.string().trim().min(1).max(80).nullable().optional(),
  topic: z.string().trim().min(1).max(120).nullable().optional(),
}).strict();

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new DomainError('请求内容不正确。', 400,
      result.error.issues.map((issue) => `${issue.path.join('.') || '请求'}: ${issue.message}`));
  }
  return result.data;
}

export async function buildServer(db: Db, clock: () => number = Date.now) {
  const app = Fastify({ bodyLimit: 40 * 1024 * 1024, logger: false });

  app.addHook('onRequest', async (request, reply) => {
    const hostname = new URL(`http://${request.headers.host ?? 'localhost'}`).hostname;
    if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
      reply.code(403).send({ error: '该服务只能通过本机地址访问。' });
      return;
    }
    reply.header('Cache-Control', 'no-store');
    if (request.method === 'GET' || request.method === 'HEAD') return;
    const origin = request.headers.origin;
    const port = apiPort();
    const trusted = new Set([
      'http://127.0.0.1:5173', 'http://localhost:5173',
      `http://127.0.0.1:${port}`, `http://localhost:${port}`,
    ]);
    if (origin && !trusted.has(origin)) {
      reply.code(403).send({ error: '只允许从本地应用页面提交数据。' });
      return;
    }
    if (!request.headers['content-type']?.startsWith('application/json')) {
      reply.code(415).send({ error: '请使用 JSON 请求。' });
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) {
      reply.code(error.statusCode).send({ error: error.message, details: error.details });
      return;
    }
    const status = error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number'
      ? error.statusCode : 500;
    reply.code(status).send({ error: status < 500 ? '请求内容无法处理。' : '服务遇到问题，请重试。' });
  });

  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/stats', async () => getStats(db, clock()));
  app.post('/api/questions/import', async (request) => {
    const schema = z.union([
      z.object({ jsonl: z.string() }).strict(),
      z.object({ files: z.array(z.object({ name: z.string().min(1).max(255), jsonl: z.string() }).strict()).min(1) }).strict(),
    ]);
    const body = parseBody(schema, request.body);
    return importQuestions(db, 'files' in body ? body.files : body.jsonl, clock());
  });
  app.put('/api/settings', async (request) => {
    const { intervalHours } = parseBody(z.object({ intervalHours: z.number().int().min(1).max(720) }).strict(), request.body);
    db.prepare('UPDATE settings SET interval_hours = ? WHERE id = 1').run(intervalHours);
    return { intervalHours };
  });
  app.post('/api/sessions', async (request) => {
    const filter = parseBody(filterSchema, request.body);
    const result = startSession(db, filter, clock());
    return { ...result, session: result.id ? getActiveView(db, clock()) : null };
  });
  app.post('/api/sessions/active/view', async () => ({ session: getActiveView(db, clock()) }));
  app.post<{ Params: { id: string } }>('/api/sessions/:id/answer', async (request) => {
    const { selectedLabel, position } = parseBody(z.object({
      selectedLabel: z.string(), position: z.number().int().min(1).max(30),
    }).strict(), request.body);
    return { session: submitAnswer(db, request.params.id, selectedLabel, clock(), position) };
  });
  app.post<{ Params: { id: string } }>('/api/sessions/:id/next', async (request) => {
    const { position } = parseBody(z.object({ position: z.number().int().min(1).max(30) }).strict(), request.body);
    return nextQuestion(db, request.params.id, clock(), position);
  });
  app.post<{ Params: { id: string } }>('/api/sessions/:id/end', async (request) => {
    const { position } = parseBody(z.object({ position: z.number().int().min(1).max(30) }).strict(), request.body);
    const id = endSession(db, request.params.id, clock(), position);
    return { summary: getSessionSummary(db, id) };
  });
  app.get<{ Params: { id: string } }>('/api/sessions/:id/summary', async (request) =>
    getSessionSummary(db, request.params.id));
  app.get('/api/backup', async (_request, reply) => {
    const backup = exportBackup(db, clock());
    reply.header('Content-Disposition', `attachment; filename="selftrain-backup-${new Date(clock()).toISOString().slice(0, 10)}.json"`);
    reply.header('Cache-Control', 'no-store');
    return backup;
  });
  app.post('/api/backup/restore', { bodyLimit: 50 * 1024 * 1024 }, async (request) => {
    restoreBackup(db, request.body);
    return { restored: true };
  });

  if (process.env.NODE_ENV === 'production') {
    await app.register(fastifyStatic, { root: resolve(process.cwd(), 'dist'), prefix: '/' });
  }
  return app;
}
