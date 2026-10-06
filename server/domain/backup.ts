import { z } from 'zod';
import { optionLetters } from '../../shared/choice';
import { questionSchema } from '../../shared/question';
import type { Db } from '../db';
import { DomainError } from './errors';
import { dedupeHash, questionHash } from './import';

const timestamp = z.number().int().nonnegative();
const nullableTime = timestamp.nullable();
const hourMs = 60 * 60 * 1000;
const maxIntervalMs = 720 * hourMs;
const questionRow = z.object({
  id: z.string(), content_hash: z.string(), language: z.string(), topic: z.string(),
  stem: z.string(), options_json: z.string(), answer: z.enum(['A', 'B', 'C', 'D']),
  explanation: z.string(), duration_seconds: z.number().int().min(1).max(3600),
  tags_json: z.string(), go_version: z.string().nullable(), imported_at: timestamp,
}).strict();
const reviewRow = z.object({
  question_id: z.string(), state: z.enum(['new', 'once_due', 'retry_due', 'done']),
  due_at: nullableTime, last_attempt_at: nullableTime,
}).strict().refine((row) =>
  (row.state === 'once_due' || row.state === 'retry_due') === (row.due_at !== null),
  { message: '复现状态和到期时间不一致' },
);
const sessionRow = z.object({
  id: z.string(), status: z.enum(['completed', 'ended']),
  phase: z.enum(['question', 'feedback']), cursor_position: z.number().int().nonnegative(),
  target_count: z.literal(30), language_filter: z.string().nullable(), topic_filter: z.string().nullable(),
  started_at: timestamp, ended_at: timestamp,
}).strict();
const itemRow = z.object({
  session_id: z.string(), position: z.number().int().nonnegative(), question_id: z.string(),
  phase: z.enum(['first', 'review']), option_order: z.string().nullable(),
  started_at: nullableTime, deadline_at: nullableTime,
}).strict();
const attemptRow = z.object({
  id: z.string(), session_id: z.string(), position: z.number().int().nonnegative(),
  question_id: z.string(), phase: z.enum(['first', 'review']),
  status: z.enum(['correct', 'wrong', 'timeout', 'abandoned']),
  selected_label: z.enum(['A', 'B', 'C', 'D']).nullable(),
  selected_original: z.enum(['A', 'B', 'C', 'D']).nullable(), option_order: z.string(),
  started_at: timestamp, completed_at: timestamp, duration_ms: z.number().int().nonnegative(),
}).strict();
const backupSchema = z.object({
  format: z.literal('selftrain-backup'),
  version: z.literal(1),
  exportedAt: timestamp,
  data: z.object({
    questions: z.array(questionRow),
    review_state: z.array(reviewRow),
    sessions: z.array(sessionRow),
    session_items: z.array(itemRow),
    attempts: z.array(attemptRow),
    settings: z.array(z.object({ id: z.literal(1), interval_hours: z.number().int().min(1).max(720) }).strict()).length(1),
  }).strict(),
}).strict();

type BackupData = z.infer<typeof backupSchema>['data'];

function validateData(data: BackupData): void {
  const questions = new Map(data.questions.map((row) => [row.id, row]));
  const items = new Map(data.session_items.map((row) => [`${row.session_id}:${row.position}`, row]));
  const sessions = new Map(data.sessions.map((row) => [row.id, row]));
  const attemptsByQuestion = new Map<string, typeof data.attempts>();
  const itemsBySession = new Map<string, typeof data.session_items>();
  const attemptedItems = new Set<string>();
  const attemptsByItem = new Map<string, typeof data.attempts[number]>();

  for (const row of data.questions) {
    const input = questionSchema.parse({
      id: row.id, language: row.language, topic: row.topic, stem: row.stem,
      options: JSON.parse(row.options_json), answer: row.answer, explanation: row.explanation,
      duration_seconds: row.duration_seconds, tags: JSON.parse(row.tags_json),
      ...(row.go_version === null ? {} : { go_version: row.go_version }),
    });
    if (questionHash(input) !== row.content_hash) throw new Error('题目内容校验值不一致');
  }

  function checkOrder(order: string) {
    const values: unknown = JSON.parse(order);
    if (!Array.isArray(values) || values.length !== 4 || new Set(values).size !== 4
      || values.some((value) => !optionLetters.includes(value))) throw new Error('选项排列无效');
  }

  for (const item of data.session_items) {
    const question = questions.get(item.question_id);
    const session = sessions.get(item.session_id);
    if (!question || !session || item.position > 29 || question.imported_at > session.started_at) {
      throw new Error('轮次题目引用不完整');
    }
    if (!itemsBySession.has(item.session_id)) itemsBySession.set(item.session_id, []);
    itemsBySession.get(item.session_id)!.push(item);
    if (item.started_at === null) {
      if (item.deadline_at !== null || item.option_order !== null) throw new Error('未打开的题目已有计时数据');
    } else {
      if (item.started_at < session.started_at || item.started_at > session.ended_at
        || item.deadline_at !== item.started_at + question.duration_seconds * 1000 || !item.option_order) {
        throw new Error('题目计时数据不一致');
      }
      checkOrder(item.option_order);
    }
  }

  for (const attempt of data.attempts) {
    const key = `${attempt.session_id}:${attempt.position}`;
    const item = items.get(key);
    const question = questions.get(attempt.question_id);
    const session = sessions.get(attempt.session_id);
    if (!item || !question || !session || attemptedItems.has(key)
      || item.question_id !== attempt.question_id || item.phase !== attempt.phase
      || item.started_at !== attempt.started_at || item.option_order !== attempt.option_order
      || item.deadline_at === null || attempt.completed_at < attempt.started_at
      || attempt.started_at < session.started_at
      || attempt.completed_at > item.deadline_at || attempt.completed_at > session.ended_at
      || attempt.duration_ms !== attempt.completed_at - attempt.started_at) {
      throw new Error('作答记录和轮次题目不一致');
    }
    checkOrder(attempt.option_order);
    const order = JSON.parse(attempt.option_order);
    if (attempt.status === 'correct' || attempt.status === 'wrong') {
      if (attempt.selected_label === null
        || order[optionLetters.indexOf(attempt.selected_label)] !== attempt.selected_original
        || (attempt.selected_original === question.answer) !== (attempt.status === 'correct')) {
        throw new Error('作答选项与结果不一致');
      }
      if (attempt.completed_at >= item.deadline_at) throw new Error('作答记录和题目截止时间不一致');
    } else {
      if (attempt.selected_label !== null || attempt.selected_original !== null
        || (attempt.status === 'timeout' && attempt.completed_at !== item.deadline_at)
        || (attempt.status === 'abandoned' && attempt.completed_at >= item.deadline_at)) {
        throw new Error('未答记录不一致');
      }
    }
    attemptedItems.add(key);
    attemptsByItem.set(key, attempt);
    if (!attemptsByQuestion.has(attempt.question_id)) attemptsByQuestion.set(attempt.question_id, []);
    attemptsByQuestion.get(attempt.question_id)!.push(attempt);
  }

  const orderedSessions = [...data.sessions].sort((a, b) =>
    a.started_at - b.started_at || a.ended_at - b.ended_at || a.id.localeCompare(b.id));
  for (let index = 1; index < orderedSessions.length; index += 1) {
    if (orderedSessions[index - 1].ended_at > orderedSessions[index].started_at) {
      throw new Error('答题轮次时间重叠');
    }
  }

  for (const session of data.sessions) {
    const sessionItems = (itemsBySession.get(session.id) ?? []).sort((a, b) => a.position - b.position);
    if (!sessionItems.length || sessionItems.length > 30 || session.ended_at < session.started_at
      || session.cursor_position >= sessionItems.length
      || sessionItems.some((item, index) => item.position !== index)) {
      throw new Error('轮次进度不一致');
    }

    const hasAttempt = (position: number) => attemptedItems.has(`${session.id}:${position}`);
    const current = sessionItems[session.cursor_position];
    if (session.status === 'completed') {
      if (session.cursor_position !== sessionItems.length - 1 || session.phase !== 'feedback'
        || sessionItems.some((item) => !hasAttempt(item.position))) {
        throw new Error('已完成轮次的进度或反馈不一致');
      }
    } else {
      if (sessionItems.some((item) => item.position < session.cursor_position && !hasAttempt(item.position))
        || sessionItems.some((item) => item.position > session.cursor_position
          && (hasAttempt(item.position) || item.started_at !== null))) {
        throw new Error('已结束轮次的作答位置不连续');
      }
      if (session.phase === 'feedback') {
        if (!current || !hasAttempt(current.position)) throw new Error('当前反馈缺少作答记录');
      } else if (!current || current.started_at !== null || hasAttempt(current.position)) {
        throw new Error('未打开的当前题目已有作答记录');
      }
    }

    for (const item of sessionItems) {
      const key = `${item.session_id}:${item.position}`;
      if (item.started_at !== null && !hasAttempt(item.position)) {
        throw new Error('已打开的题目缺少作答记录');
      }
      const history = attemptsByQuestion.get(item.question_id) ?? [];
      const prior = history.filter((attempt) => attempt.session_id !== session.id
        && attempt.completed_at <= session.started_at)
        .sort((a, b) => b.completed_at - a.completed_at)[0];
      if (item.phase === 'first') {
        if (prior) throw new Error('首次题目与既有作答历史不一致');
      } else if (!prior || (prior.phase === 'review' && prior.status === 'correct')
        || session.started_at < prior.completed_at + hourMs) {
        throw new Error('复习题目没有有效的首次作答或复现间隔');
      }
      if (attemptsByItem.has(key) && item.started_at === null) {
        throw new Error('作答记录对应的题目尚未打开');
      }
    }

    for (let position = 1; position < sessionItems.length; position += 1) {
      const previousAttempt = attemptsByItem.get(`${session.id}:${position - 1}`);
      const currentItem = sessionItems[position];
      if (currentItem.started_at !== null
        && (!previousAttempt || previousAttempt.completed_at > currentItem.started_at)) {
        throw new Error('同一轮题目开始时间早于上一题完成时间');
      }
    }
  }

  if (data.review_state.length !== data.questions.length
    || new Set(data.review_state.map((row) => row.question_id)).size !== data.questions.length) {
    throw new Error('复现状态不完整');
  }
  for (const row of data.review_state) {
    if (!questions.has(row.question_id)) throw new Error('复现状态引用不存在的题目');
    const history = (attemptsByQuestion.get(row.question_id) ?? []).sort((a, b) => a.completed_at - b.completed_at);
    let completedReview = false;
    for (const [index, attempt] of history.entries()) {
      if (attempt.phase !== (index === 0 ? 'first' : 'review') || completedReview
        || (index > 0 && attempt.started_at < history[index - 1].completed_at + hourMs)) {
        throw new Error('作答阶段顺序或复现间隔不一致');
      }
      if (attempt.phase === 'review' && attempt.status === 'correct') completedReview = true;
    }
    const last = history.at(-1);
    const expected = !last ? 'new' : last.status === 'correct'
      ? (last.phase === 'first' ? 'once_due' : 'done') : 'retry_due';
    if (row.state !== expected || row.last_attempt_at !== (last?.completed_at ?? null)
      || (row.due_at !== null && (!last || row.due_at < last.completed_at + hourMs
        || row.due_at > last.completed_at + maxIntervalMs))) {
      throw new Error('复现状态与作答历史不一致');
    }
  }
}

const tableOrder = ['questions', 'review_state', 'sessions', 'session_items', 'attempts', 'settings'] as const;

function ensureIdle(db: Db): void {
  if (db.prepare("SELECT 1 FROM sessions WHERE status = 'active'").get()) {
    throw new DomainError('请先结束当前答题，再备份或恢复数据。', 409);
  }
}

export function exportBackup(db: Db, now: number) {
  ensureIdle(db);
  const data = Object.fromEntries(tableOrder.map((table) => [
    table,
    db.prepare(table === 'questions'
      ? 'SELECT id, content_hash, language, topic, stem, options_json, answer, explanation, duration_seconds, tags_json, go_version, imported_at FROM questions'
      : `SELECT * FROM ${table}`).all(),
  ]));
  return backupSchema.parse({ format: 'selftrain-backup', version: 1, exportedAt: now, data });
}

export function restoreBackup(db: Db, raw: unknown): void {
  ensureIdle(db);
  const parsed = backupSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DomainError('备份格式或版本不正确，现有数据未改变。', 400,
      parsed.error.issues.slice(0, 10).map((issue) => `${issue.path.join('.')}: ${issue.message}`));
  }
  const data = parsed.data.data;
  try {
    validateData(data);
    db.transaction(() => {
      for (const table of [...tableOrder].reverse()) db.prepare(`DELETE FROM ${table}`).run();
      for (const table of tableOrder) {
        for (const row of data[table]) {
          const columns = Object.keys(row);
          const placeholders = columns.map(() => '?').join(', ');
          if (table === 'questions') {
            const question = row as z.infer<typeof questionRow>;
            const input = questionSchema.parse({ id: question.id, language: question.language, topic: question.topic, stem: question.stem,
              options: JSON.parse(question.options_json), answer: question.answer, explanation: question.explanation,
              duration_seconds: question.duration_seconds, tags: JSON.parse(question.tags_json), ...(question.go_version === null ? {} : { go_version: question.go_version }) });
            columns.push('dedupe_hash');
            db.prepare(`INSERT INTO questions (${columns.join(', ')}) VALUES (${[...placeholders.split(', '), '?'].join(', ')})`)
              .run(...Object.values(row), dedupeHash(input));
          } else {
            db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`).run(...Object.values(row));
          }
        }
      }
      const problems = db.prepare('PRAGMA foreign_key_check').all();
      if (problems.length) throw new Error('备份记录之间的引用不完整');
    })();
  } catch {
    throw new DomainError('备份内容不完整或记录冲突，现有数据未改变。');
  }
}
