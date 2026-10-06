import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../server/db';
import { openDatabase } from '../server/db';
import { exportBackup, restoreBackup } from '../server/domain/backup';
import { importQuestions } from '../server/domain/import';
import { startSession } from '../server/domain/scheduler';
import { endSession, getActiveView, nextQuestion, submitAnswer } from '../server/domain/session';
import type { SessionView } from '../shared/api';
import type { OptionLetter } from '../shared/question';

const base = 1_760_000_000_000;
const hour = 60 * 60 * 1000;

function question(id: string) {
  return {
    id,
    language: 'Go',
    topic: '基础语法',
    stem: `题目 ${id}`,
    options: { A: `正确-${id}`, B: `错误1-${id}`, C: `错误2-${id}`, D: `错误3-${id}` },
    answer: 'A',
    explanation: 'A 是正确答案。',
    duration_seconds: 2,
  };
}

function labelFor(view: SessionView, correct: boolean): OptionLetter {
  if (view.phase !== 'question') throw new Error('当前不是题目');
  return (Object.keys(view.question.options) as OptionLetter[]).find((label) =>
    view.question.options[label].startsWith(correct ? '正确-' : '错误'))!;
}

function tableSnapshot(db: Db) {
  return ['questions', 'review_state', 'sessions', 'session_items', 'attempts', 'settings']
    .map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}

describe('备份作答历史完整性', () => {
  let db: Db;

  beforeEach(() => { db = openDatabase(':memory:'); });
  afterEach(() => { db.close(); });

  function addQuestions(...ids: string[]) {
    importQuestions(db, ids.map((id) => JSON.stringify(question(id))).join('\n'), base);
  }

  function rejectWithoutChangingDatabase(raw: unknown) {
    const before = tableSnapshot(db);
    expect(() => restoreBackup(db, raw)).toThrow(/未改变/);
    expect(tableSnapshot(db)).toEqual(before);
  }

  it('拒绝把唯一的首次答对记录伪装成已完成的复现，并保留原库', () => {
    addQuestions('one');
    const started = startSession(db, {}, base);
    const view = getActiveView(db, base)!;
    submitAnswer(db, started.id!, labelFor(view, true), base + 100);
    nextQuestion(db, started.id!, base + 200);
    const tampered = structuredClone(exportBackup(db, base + 200));
    tampered.data.attempts[0].phase = 'review';
    tampered.data.session_items[0].phase = 'review';
    tampered.data.review_state[0].state = 'done';
    tampered.data.review_state[0].due_at = null;

    rejectWithoutChangingDatabase(tampered);
  });

  it('允许首次答对、复现答错、再答对的历史往返恢复', () => {
    addQuestions('one');
    db.prepare('UPDATE settings SET interval_hours = 1 WHERE id = 1').run();

    const first = startSession(db, {}, base);
    const firstView = getActiveView(db, base)!;
    submitAnswer(db, first.id!, labelFor(firstView, true), base + 100);
    nextQuestion(db, first.id!, base + 200);

    const review = startSession(db, {}, base + hour + 100);
    const reviewView = getActiveView(db, base + hour + 100)!;
    submitAnswer(db, review.id!, labelFor(reviewView, false), base + hour + 200);
    nextQuestion(db, review.id!, base + hour + 300);

    const retry = startSession(db, {}, base + 2 * hour + 200);
    const retryView = getActiveView(db, base + 2 * hour + 200)!;
    submitAnswer(db, retry.id!, labelFor(retryView, true), base + 2 * hour + 300);
    nextQuestion(db, retry.id!, base + 2 * hour + 400);

    const backup = exportBackup(db, base + 2 * hour + 400);
    restoreBackup(db, backup);
    expect(db.prepare('SELECT phase, status FROM attempts ORDER BY completed_at')
      .all()).toEqual([
      { phase: 'first', status: 'correct' },
      { phase: 'review', status: 'wrong' },
      { phase: 'review', status: 'correct' },
    ]);
    expect(db.prepare('SELECT state, due_at FROM review_state WHERE question_id = ?').get('one'))
      .toEqual({ state: 'done', due_at: null });

    const answeredDone = structuredClone(backup);
    const middle = answeredDone.data.attempts.find((attempt) => attempt.phase === 'review'
      && attempt.status === 'wrong')!;
    const order = JSON.parse(middle.option_order) as string[];
    middle.status = 'correct';
    middle.selected_original = 'A';
    middle.selected_label = (['A', 'B', 'C', 'D'] as const)[order.indexOf('A')];
    rejectWithoutChangingDatabase(answeredDone);
  });

  it('往返恢复超时、放弃、部分结束，以及从未打开就结束的轮次', () => {
    addQuestions('timeout', 'abandoned');
    const timed = startSession(db, {}, base);
    getActiveView(db, base);
    getActiveView(db, base + 2_000);
    nextQuestion(db, timed.id!, base + 2_000);
    endSession(db, timed.id!, base + 2_100);
    const firstBackup = exportBackup(db, base + 2_100);
    restoreBackup(db, firstBackup);
    expect(db.prepare('SELECT status FROM attempts ORDER BY completed_at').all())
      .toEqual([{ status: 'timeout' }, { status: 'abandoned' }]);

    addQuestions('partial-a', 'partial-b', 'partial-c');
    const partial = startSession(db, {}, base + 10_000);
    const firstView = getActiveView(db, base + 10_000)!;
    submitAnswer(db, partial.id!, labelFor(firstView, false), base + 10_100);
    nextQuestion(db, partial.id!, base + 10_200);
    endSession(db, partial.id!, base + 10_300);
    const partialBackup = exportBackup(db, base + 10_300);
    restoreBackup(db, partialBackup);
    const partialItems = partialBackup.data.session_items.filter((item) => item.session_id === partial.id);
    expect(partialItems.filter((item) => item.started_at === null))
      .toHaveLength(1);
    const missingOpenedAttempt = structuredClone(partialBackup);
    const currentItem = missingOpenedAttempt.data.session_items.find((item) =>
      item.session_id === partial.id && item.position === 1)!;
    missingOpenedAttempt.data.attempts = missingOpenedAttempt.data.attempts.filter((attempt) =>
      attempt.session_id !== partial.id || attempt.position !== currentItem.position);
    const currentState = missingOpenedAttempt.data.review_state.find((row) =>
      row.question_id === currentItem.question_id)!;
    currentState.state = 'new';
    currentState.due_at = null;
    currentState.last_attempt_at = null;
    rejectWithoutChangingDatabase(missingOpenedAttempt);

    addQuestions('unopened-a', 'unopened-b');
    const unopened = startSession(db, {}, base + 20_000);
    endSession(db, unopened.id!, base + 20_000);
    const unopenedBackup = exportBackup(db, base + 20_000);
    restoreBackup(db, unopenedBackup);
    expect(unopenedBackup.data.attempts.some((attempt) => attempt.session_id === unopened.id)).toBe(false);
    expect(unopenedBackup.data.sessions.find((session) => session.id === unopened.id))
      .toMatchObject({ status: 'ended', phase: 'question', cursor_position: 0 });
  });

  it('允许零耗时首次答对和零耗时放弃的真实记录往返恢复', () => {
    addQuestions('instant-correct', 'instant-abandon');
    const started = startSession(db, {}, base);
    const view = getActiveView(db, base)!;
    endSession(db, started.id!, base);

    const second = startSession(db, {}, base + 1_000);
    const secondView = getActiveView(db, base + 1_000)!;
    submitAnswer(db, second.id!, labelFor(secondView, true), base + 1_000);
    nextQuestion(db, second.id!, base + 1_000);

    const backup = exportBackup(db, base + 1_000);
    restoreBackup(db, backup);
    expect(db.prepare('SELECT phase, status, duration_ms FROM attempts ORDER BY status').all())
      .toEqual([
        { phase: 'first', status: 'abandoned', duration_ms: 0 },
        { phase: 'first', status: 'correct', duration_ms: 0 },
      ]);
  });

  it('按最后一次作答校验 1–720 小时到期范围，保留旧间隔', () => {
    addQuestions('one');
    db.prepare('UPDATE settings SET interval_hours = 720 WHERE id = 1').run();
    const started = startSession(db, {}, base);
    const view = getActiveView(db, base)!;
    submitAnswer(db, started.id!, labelFor(view, false), base + 100);
    nextQuestion(db, started.id!, base + 200);
    db.prepare('UPDATE settings SET interval_hours = 1 WHERE id = 1').run();

    const backup = exportBackup(db, base + 200);
    expect(backup.data.review_state[0].due_at).toBe(base + 100 + 720 * hour);
    restoreBackup(db, backup);

    const tooSoon = structuredClone(backup);
    tooSoon.data.review_state[0].due_at = base + 100 + hour - 1;
    rejectWithoutChangingDatabase(tooSoon);

    const tooLate = structuredClone(backup);
    tooLate.data.review_state[0].due_at = base + 100 + 721 * hour;
    rejectWithoutChangingDatabase(tooLate);
  });

  it('拒绝轮次时间倒置和互相重叠的会话', () => {
    addQuestions('one');
    db.prepare('UPDATE settings SET interval_hours = 1 WHERE id = 1').run();
    const first = startSession(db, {}, base);
    const firstView = getActiveView(db, base)!;
    submitAnswer(db, first.id!, labelFor(firstView, false), base + 100);
    nextQuestion(db, first.id!, base + 200);
    const second = startSession(db, {}, base + hour + 100);
    const secondView = getActiveView(db, base + hour + 100)!;
    submitAnswer(db, second.id!, labelFor(secondView, false), base + hour + 200);
    nextQuestion(db, second.id!, base + hour + 300);
    const backup = exportBackup(db, base + hour + 300);

    const itemBeforeSession = structuredClone(backup);
    itemBeforeSession.data.sessions[0].started_at = base + 1;
    rejectWithoutChangingDatabase(itemBeforeSession);

    const overlap = structuredClone(backup);
    overlap.data.sessions[0].ended_at = overlap.data.sessions[1].started_at + 1;
    rejectWithoutChangingDatabase(overlap);
  });

  it('同一轮后一题不能早于前一题完成，但相同时间戳有效', () => {
    addQuestions('one', 'two');
    const started = startSession(db, {}, base);
    let view = getActiveView(db, base)!;
    submitAnswer(db, started.id!, labelFor(view, true), base + 100);
    nextQuestion(db, started.id!, base + 200);
    view = getActiveView(db, base + 200)!;
    submitAnswer(db, started.id!, labelFor(view, true), base + 300);
    nextQuestion(db, started.id!, base + 400);
    const backup = exportBackup(db, base + 400);
    const firstItem = backup.data.session_items.find((item) =>
      item.session_id === started.id && item.position === 0)!;
    const secondItem = backup.data.session_items.find((item) =>
      item.session_id === started.id && item.position === 1)!;
    const updateFirstAttempt = (copy: typeof backup, completedAt: number) => {
      const attempt = copy.data.attempts.find((row) =>
        row.session_id === started.id && row.position === 0)!;
      attempt.completed_at = completedAt;
      attempt.duration_ms = completedAt - attempt.started_at;
      const review = copy.data.review_state.find((row) => row.question_id === firstItem.question_id)!;
      review.last_attempt_at = completedAt;
      review.due_at = completedAt + copy.data.settings[0].interval_hours * hour;
    };

    const equalTimestamps = structuredClone(backup);
    updateFirstAttempt(equalTimestamps, secondItem.started_at!);
    restoreBackup(db, equalTimestamps);

    const outOfOrder = structuredClone(backup);
    updateFirstAttempt(outOfOrder, secondItem.started_at! + 1);
    rejectWithoutChangingDatabase(outOfOrder);
  });

  it('已结束轮次的未来题不能被打开，已完成轮次光标和阶段必须匹配', () => {
    addQuestions('one', 'two', 'three');
    const started = startSession(db, {}, base);
    const view = getActiveView(db, base)!;
    submitAnswer(db, started.id!, labelFor(view, true), base + 100);
    nextQuestion(db, started.id!, base + 200);
    endSession(db, started.id!, base + 300);
    const backup = exportBackup(db, base + 300);

    const openedFuture = structuredClone(backup);
    const sessionItems = openedFuture.data.session_items.filter((item) => item.session_id === started.id);
    sessionItems[2].started_at = base + 250;
    sessionItems[2].deadline_at = base + 2_250;
    sessionItems[2].option_order = '["A","B","C","D"]';
    rejectWithoutChangingDatabase(openedFuture);

    addQuestions('four', 'five');
    const completed = startSession(db, {}, base + 1_000);
    let now = base + 1_000;
    for (let position = 0; position < completed.total; position += 1) {
      const current = getActiveView(db, now)!;
      submitAnswer(db, completed.id!, labelFor(current, true), now + 100);
      nextQuestion(db, completed.id!, now + 200);
      now += 200;
    }
    const completedBackup = exportBackup(db, now);
    const wrongCursor = structuredClone(completedBackup);
    const completedSession = wrongCursor.data.sessions.find((session) => session.id === completed.id)!;
    completedSession.cursor_position -= 1;
    rejectWithoutChangingDatabase(wrongCursor);

    const wrongPhase = structuredClone(completedBackup);
    wrongPhase.data.sessions.find((session) => session.id === completed.id)!.phase = 'question';
    rejectWithoutChangingDatabase(wrongPhase);
  });
});
