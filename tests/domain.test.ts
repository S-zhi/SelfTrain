import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../server/db';
import { openDatabase } from '../server/db';
import { exportBackup, restoreBackup } from '../server/domain/backup';
import { DomainError } from '../server/domain/errors';
import { importQuestions } from '../server/domain/import';
import { startSession } from '../server/domain/scheduler';
import { endSession, getActiveView, getSessionSummary, nextQuestion, submitAnswer } from '../server/domain/session';
import { getStats } from '../server/domain/stats';
import type { SessionView } from '../shared/api';
import type { OptionLetter } from '../shared/question';

const hour = 60 * 60 * 1000;
const time = 1_760_000_000_000;

function question(id: string, extra: Record<string, unknown> = {}) {
  return {
    id, language: 'Go', topic: '基础语法', stem: `题目 ${id}`,
    options: { A: `正确-${id}`, B: `错1-${id}`, C: `错2-${id}`, D: `错3-${id}` },
    answer: 'A', explanation: 'A 是正确答案。', duration_seconds: 2,
    ...extra,
  };
}

function correctLabel(view: SessionView): OptionLetter {
  if (view.phase !== 'question') throw new Error('当前不是题目');
  return (Object.keys(view.question.options) as OptionLetter[])
    .find((key) => view.question.options[key] === `正确-${view.question.id}`)!;
}

function wrongLabel(view: SessionView): OptionLetter {
  return (['A', 'B', 'C', 'D'] as OptionLetter[]).find((label) => label !== correctLabel(view))!;
}

describe('题目、复现与计时', () => {
  let db: Db;
  beforeEach(() => { db = openDatabase(':memory:'); });
  afterEach(() => { db.close(); });

  it('整批导入、重复跳过，任何坏行或内容冲突均不产生部分写入', () => {
    expect(importQuestions(db, JSON.stringify(question('one')), time)).toEqual({ imported: 1, skipped: 0, total: 1 });
    expect(importQuestions(db, JSON.stringify(question('one')), time).skipped).toBe(1);
    expect(() => importQuestions(db, [JSON.stringify(question('two')), '{bad'].join('\n'), time))
      .toThrow(DomainError);
    expect(() => importQuestions(db, [JSON.stringify(question('three')), JSON.stringify(question('one', { explanation: '改动' }))].join('\n'), time))
      .toThrow(/没有写入/);
    expect((db.prepare('SELECT COUNT(*) AS n FROM questions').get() as { n: number }).n).toBe(1);
  });

  it('首次答对间隔复现一次；复现时答错转入错题循环，之后答对才结束', () => {
    importQuestions(db, JSON.stringify(question('one')), time);
    const first = startSession(db, {}, time);
    const view = getActiveView(db, time)!;
    expect(view.phase).toBe('question');
    const feedback = submitAnswer(db, first.id!, correctLabel(view), time + 500);
    expect(feedback.phase).toBe('feedback');
    if (feedback.phase === 'feedback') expect(feedback.feedback.status).toBe('correct');
    nextQuestion(db, first.id!, time + 600);
    expect(startSession(db, {}, time + 23 * hour).total).toBe(0);
    const second = startSession(db, {}, time + 24 * hour + 500);
    expect(second.total).toBe(1);
    const review = getActiveView(db, time + 24 * hour + 500)!;
    expect(review.phase === 'question' && review.question.phase).toBe('review');
    const again = submitAnswer(db, second.id!, wrongLabel(review), time + 24 * hour + 700);
    expect(again.phase === 'feedback' && again.feedback.status).toBe('wrong');
    nextQuestion(db, second.id!, time + 24 * hour + 800);
    expect(startSession(db, {}, time + 48 * hour + 699).total).toBe(0);

    const third = startSession(db, {}, time + 48 * hour + 700);
    const retry = getActiveView(db, time + 48 * hour + 700)!;
    submitAnswer(db, third.id!, correctLabel(retry), time + 48 * hour + 900);
    nextQuestion(db, third.id!, time + 48 * hour + 1000);
    expect(startSession(db, {}, time + 100 * hour).total).toBe(0);
    expect(getStats(db, time + 100 * hour).questions.done).toBe(1);
  });

  it('超时按原截止时间记录，刷新不会获得新的计时；主动退出只放弃已打开的题', () => {
    importQuestions(db, [question('one'), question('two')].map((entry) => JSON.stringify(entry)).join('\n'), time);
    const started = startSession(db, {}, time);
    const view = getActiveView(db, time)!;
    expect(view.phase).toBe('question');
    expect(getActiveView(db, time + 1000)).toEqual(view);
    const timeout = getActiveView(db, time + 3000)!;
    expect(timeout.phase).toBe('feedback');
    if (timeout.phase === 'feedback') {
      expect(timeout.feedback.status).toBe('timeout');
      expect(timeout.feedback.elapsedMs).toBe(2000);
    }
    const next = nextQuestion(db, started.id!, time + 3000).session!;
    expect(next.phase).toBe('question');
    endSession(db, started.id!, time + 3500);
    const summary = getSessionSummary(db, started.id!);
    expect(summary.attemptedCount).toBe(2);
    expect(summary.timeoutCount).toBe(1);
    expect(summary.abandonedCount).toBe(1);
    expect(summary.status).toBe('ended');
  });

  it('达到 30 题即封顶，到期题优先，未打开的题不记录', () => {
    const entries = Array.from({ length: 35 }, (_, i) => question(`go-${String(i).padStart(2, '0')}`));
    importQuestions(db, entries.map((entry) => JSON.stringify(entry)).join('\n'), time);
    const first = startSession(db, {}, time);
    expect(first.total).toBe(30);
    expect(() => startSession(db, {}, time)).toThrow(/已有进行中/);
    getActiveView(db, time);
    endSession(db, first.id!, time + 200);
    const summary = getSessionSummary(db, first.id!);
    expect(summary.plannedCount).toBe(30);
    expect(summary.attemptedCount).toBe(1);
    expect(startSession(db, {}, time + 1000).total).toBe(30);
  });

  it('复现间隔修改只影响今后的安排；首次成绩与复习成绩分离', () => {
    importQuestions(db, JSON.stringify(question('one')), time);
    const first = startSession(db, {}, time);
    const initial = getActiveView(db, time)!;
    submitAnswer(db, first.id!, wrongLabel(initial), time + 100);
    nextQuestion(db, first.id!, time + 200);
    db.prepare('UPDATE settings SET interval_hours = 48 WHERE id = 1').run();
    const second = startSession(db, {}, time + 24 * hour + 100);
    expect(second.total).toBe(1);
    const review = getActiveView(db, time + 24 * hour + 100)!;
    submitAnswer(db, second.id!, wrongLabel(review), time + 24 * hour + 200);
    nextQuestion(db, second.id!, time + 24 * hour + 300);
    expect(startSession(db, {}, time + 72 * hour + 199).total).toBe(0);
    expect(startSession(db, {}, time + 72 * hour + 200).total).toBe(1);
    const stats = getStats(db, time + 72 * hour + 200);
    expect(stats.first).toMatchObject({ correct: 0, total: 1 });
    expect(stats.review).toMatchObject({ correct: 0, total: 1 });
  });

  it('完整备份恢复保留复现状态；坏备份回滚且活动轮次不可恢复', () => {
    importQuestions(db, JSON.stringify(question('one')), time);
    const backup = exportBackup(db, time);
    const session = startSession(db, {}, time);
    expect(() => exportBackup(db, time)).toThrow(/结束当前答题/);
    endSession(db, session.id!, time);
    restoreBackup(db, backup);
    expect(getStats(db, time).questions.new).toBe(1);
    const bad = structuredClone(backup);
    bad.data.review_state[0].question_id = 'missing';
    expect(() => restoreBackup(db, bad)).toThrow(/未改变/);
    expect(getStats(db, time).questions.new).toBe(1);
  });
});
