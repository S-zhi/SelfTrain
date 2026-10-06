import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../server/db';
import { exportBackup, restoreBackup } from '../server/domain/backup';
import { importQuestions } from '../server/domain/import';
import { startSession } from '../server/domain/scheduler';
import { endSession, getActiveView, getSessionSummary, nextQuestion, submitAnswer } from '../server/domain/session';
import { getStats } from '../server/domain/stats';
import type { OptionLetter, QuestionInput } from '../shared/question';

const base = 1_760_000_000_000;
const hour = 60 * 60 * 1000;
const examples = readFileSync(new URL('../examples/go-syntax.jsonl', import.meta.url), 'utf8');
const fixtureMap = new Map(examples.trim().split('\n').map((line) => {
  const question = JSON.parse(line) as QuestionInput;
  return [question.id, question];
}));

function simple(id = 'one', language = 'Go') {
  return { id, language, topic: '语法', stem: '选择正确答案', options: { A: '正确', B: '错误1', C: '错误2', D: '错误3' }, answer: 'A', explanation: '说明', duration_seconds: 2 };
}

describe('完整轮次与数据不变量', () => {
  it('完成 30 道新题后只在到期时复现一次，复现全部答对后不再出现', () => {
    const db = openDatabase(':memory:');
    try {
      importQuestions(db, examples, base);
      let now = base;
      for (const phase of ['first', 'review'] as const) {
        const started = startSession(db, {}, now);
        expect(started.total).toBe(30);
        for (let position = 1; position <= 30; position += 1) {
          const current = getActiveView(db, now)!;
          if (current.phase !== 'question') throw new Error('不是题目');
          expect(current.question.phase).toBe(phase);
          const reference = fixtureMap.get(current.question.id)!;
          const label = (Object.keys(current.question.options) as OptionLetter[])
            .find((key) => current.question.options[key] === reference.options[reference.answer].trim())!;
          now += 100;
          submitAnswer(db, started.id!, label, now, position);
          now += 100;
          const next = nextQuestion(db, started.id!, now, position);
          expect(next.summaryId === started.id).toBe(position === 30);
        }
        const summary = getSessionSummary(db, started.id!);
        expect(summary.attemptedCount).toBe(30);
        expect(summary[phase]).toMatchObject({ correct: 30, total: 30 });
        if (phase === 'first') {
          expect(startSession(db, {}, now + 23 * hour).total).toBe(0);
          now += 24 * hour;
        }
      }
      expect(getStats(db, now).questions.done).toBe(30);
      expect(startSession(db, {}, now + 1000 * hour).total).toBe(0);
    } finally { db.close(); }
  });

  it('到期排序和语言筛选生效，新题不会挡住更早到期的旧题', () => {
    const db = openDatabase(':memory:');
    try {
      importQuestions(db, [simple('early'), simple('later'), simple('new'), simple('rust', 'Rust')]
        .map((q) => JSON.stringify(q)).join('\n'), base);
      db.prepare("UPDATE review_state SET state = 'retry_due', due_at = ? WHERE question_id = ?").run(base - 200, 'early');
      db.prepare("UPDATE review_state SET state = 'retry_due', due_at = ? WHERE question_id = ?").run(base - 100, 'later');
      const started = startSession(db, { language: 'Go' }, base);
      const planned = db.prepare('SELECT question_id FROM session_items WHERE session_id = ? ORDER BY position')
        .all(started.id) as Array<{ question_id: string }>;
      expect(planned.map((row) => row.question_id)).toEqual(['early', 'later', 'new']);
    } finally { db.close(); }
  });

  it('重启文件数据库保留题目排列和原截止时间，超时与历史可完整恢复', () => {
    const directory = mkdtempSync(join(tmpdir(), 'selftrain-persistence-'));
    const path = join(directory, 'test.sqlite');
    let db = openDatabase(path);
    try {
      importQuestions(db, JSON.stringify(simple()), base);
      const started = startSession(db, {}, base);
      const initial = getActiveView(db, base)!;
      db.close();
      db = openDatabase(path);
      expect(getActiveView(db, base + 1000)).toEqual(initial);
      const expired = getActiveView(db, base + 3000)!;
      expect(expired.phase === 'feedback' && expired.feedback.status).toBe('timeout');
      endSession(db, started.id!, base + 3000, 1);
      const backup = exportBackup(db, base + 3000);
      restoreBackup(db, backup);
      expect(getStats(db, base + 3000).first).toMatchObject({ correct: 0, total: 1 });
      expect(getStats(db, base + 3000).questions.waiting).toBe(1);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('题目或版本损坏的备份在替换前被拒绝', () => {
    const db = openDatabase(':memory:');
    try {
      importQuestions(db, JSON.stringify(simple()), base);
      const backup = exportBackup(db, base);
      const corrupt = structuredClone(backup);
      corrupt.data.questions[0].options_json = '{broken';
      expect(() => restoreBackup(db, corrupt)).toThrow(/未改变/);
      const changed = structuredClone(backup);
      changed.data.questions[0].explanation = '未更新哈希的改动';
      expect(() => restoreBackup(db, changed)).toThrow(/未改变/);
      expect(() => restoreBackup(db, { ...backup, version: 2 })).toThrow(/版本/);
      expect(getStats(db, base).questions.total).toBe(1);
    } finally { db.close(); }
  });

  it('另一个标签页的旧题提交、下一题或结束请求不能影响当前新题', () => {
    const db = openDatabase(':memory:');
    try {
      importQuestions(db, [simple('one'), simple('two')].map((q) => JSON.stringify(q)).join('\n'), base);
      const started = startSession(db, {}, base);
      getActiveView(db, base);
      submitAnswer(db, started.id!, 'A', base + 100, 1);
      nextQuestion(db, started.id!, base + 200, 1);
      expect(() => submitAnswer(db, started.id!, 'B', base + 300, 1)).toThrow(/另一个页面/);
      expect(() => nextQuestion(db, started.id!, base + 300, 1)).toThrow(/另一个页面/);
      expect(() => endSession(db, started.id!, base + 300, 1)).toThrow(/另一个页面/);
      expect(getStats(db, base + 300).first.total).toBe(1);
      expect(getActiveView(db, base + 300)?.position).toBe(2);
    } finally { db.close(); }
  });

  it('同一文件中的冲突 ID、缺少时限或重复选项都使整批回滚', () => {
    const db = openDatabase(':memory:');
    try {
      expect(() => importQuestions(db, [simple(), { ...simple(), explanation: '不同' }].map((q) => JSON.stringify(q)).join('\n'), base)).toThrow(/没有写入/);
      const { duration_seconds: omitted, ...missing } = simple();
      expect(() => importQuestions(db, JSON.stringify(missing), base)).toThrow(/没有写入/);
      expect(() => importQuestions(db, JSON.stringify({ ...simple(), options: { A: '同', B: '同', C: '三', D: '四' } }), base)).toThrow(/没有写入/);
      expect(getStats(db, base).questions.total).toBe(0);
    } finally { db.close(); }
  });
});
