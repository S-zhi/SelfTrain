import { randomInt, randomUUID } from 'node:crypto';
import type { AttemptPhase, AttemptStatus, Feedback, Score, SessionSummary, SessionView, VisibleQuestion } from '../../shared/api';
import { isOptionLetter, optionLetters, type OptionLetter } from '../../shared/question';
import type { Db } from '../db';
import { DomainError } from './errors';

type SessionRow = {
  id: string;
  status: 'active' | 'completed' | 'ended';
  phase: 'question' | 'feedback';
  cursor_position: number;
  target_count: number;
  started_at: number;
  ended_at: number | null;
};

type ItemRow = {
  session_id: string;
  position: number;
  question_id: string;
  phase: AttemptPhase;
  option_order: string | null;
  started_at: number | null;
  deadline_at: number | null;
  language: string;
  topic: string;
  stem: string;
  options_json: string;
  answer: OptionLetter;
  explanation: string;
  duration_seconds: number;
};

type AttemptRow = {
  status: AttemptStatus;
  selected_label: OptionLetter | null;
  option_order: string;
  duration_ms: number;
};

function activeSession(db: Db, id?: string): SessionRow | undefined {
  return db.prepare(`SELECT id, status, phase, cursor_position, target_count, started_at, ended_at
    FROM sessions WHERE status = 'active' ${id ? 'AND id = ?' : ''}`)
    .get(...(id ? [id] : [])) as SessionRow | undefined;
}

function itemAt(db: Db, session: SessionRow): ItemRow {
  const item = db.prepare(`
    SELECT i.*, q.language, q.topic, q.stem, q.options_json, q.answer,
      q.explanation, q.duration_seconds
    FROM session_items i JOIN questions q ON q.id = i.question_id
    WHERE i.session_id = ? AND i.position = ?
  `).get(session.id, session.cursor_position) as ItemRow | undefined;
  if (!item) throw new DomainError('当前轮次的题目不存在。', 500);
  return item;
}

function shuffleOptions(): OptionLetter[] {
  const shuffled: OptionLetter[] = [...optionLetters];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function orderOf(item: ItemRow): OptionLetter[] {
  if (!item.option_order) throw new DomainError('题目的选项排列尚未生成。', 500);
  return JSON.parse(item.option_order) as OptionLetter[];
}

function visibleQuestion(db: Db, item: ItemRow): VisibleQuestion {
  const original = JSON.parse(item.options_json) as Record<OptionLetter, string>;
  const order = orderOf(item);
  const total = (db.prepare('SELECT COUNT(*) AS count FROM session_items WHERE session_id = ?')
    .get(item.session_id) as { count: number }).count;
  return {
    id: item.question_id,
    language: item.language,
    topic: item.topic,
    stem: item.stem,
    options: {
      A: original[order[0]],
      B: original[order[1]],
      C: original[order[2]],
      D: original[order[3]],
    },
    durationSeconds: item.duration_seconds,
    startedAt: item.started_at!,
    deadlineAt: item.deadline_at!,
    position: item.position + 1,
    total,
    phase: item.phase,
  };
}

function feedbackFor(db: Db, item: ItemRow): Feedback {
  const attempt = db.prepare('SELECT status, selected_label, option_order, duration_ms FROM attempts WHERE session_id = ? AND position = ?')
    .get(item.session_id, item.position) as AttemptRow | undefined;
  if (!attempt) throw new DomainError('没有找到这道题的作答记录。', 500);
  const correctLabel = optionLetters[(JSON.parse(attempt.option_order) as OptionLetter[]).indexOf(item.answer)];
  return {
    question: visibleQuestion(db, item),
    status: attempt.status,
    selectedLabel: attempt.selected_label,
    correctLabel,
    explanation: item.explanation,
    elapsedMs: attempt.duration_ms,
  };
}

function finishAttempt(
  db: Db,
  session: SessionRow,
  item: ItemRow,
  status: AttemptStatus,
  selectedLabel: OptionLetter | null,
  now: number,
): void {
  if (item.started_at === null || item.deadline_at === null) {
    throw new DomainError('这道题尚未开始计时。', 409);
  }
  const completedAt = status === 'timeout' ? item.deadline_at : now;
  const elapsedMs = Math.max(0, Math.min(completedAt - item.started_at, item.duration_seconds * 1000));
  const order = orderOf(item);
  const selectedOriginal = selectedLabel === null ? null : order[optionLetters.indexOf(selectedLabel)];
  db.prepare(`
    INSERT INTO attempts (id, session_id, position, question_id, phase, status,
      selected_label, selected_original, option_order, started_at, completed_at, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), session.id, item.position, item.question_id, item.phase,
    status, selectedLabel, selectedOriginal, item.option_order, item.started_at, completedAt, elapsedMs);

  const nextState = status === 'correct'
    ? (item.phase === 'first' ? 'once_due' : 'done')
    : 'retry_due';
  const intervalHours = (db.prepare('SELECT interval_hours FROM settings WHERE id = 1')
    .get() as { interval_hours: number }).interval_hours;
  const dueAt = nextState === 'done' ? null : completedAt + intervalHours * 60 * 60 * 1000;
  db.prepare('UPDATE review_state SET state = ?, due_at = ?, last_attempt_at = ? WHERE question_id = ?')
    .run(nextState, dueAt, completedAt, item.question_id);
  db.prepare("UPDATE sessions SET phase = 'feedback' WHERE id = ?").run(session.id);
}

function renderSession(db: Db, session: SessionRow, now: number): SessionView {
  let item = itemAt(db, session);
  if (session.phase === 'question') {
    if (item.started_at === null) {
      const startedAt = now;
      const deadlineAt = startedAt + item.duration_seconds * 1000;
      const order = JSON.stringify(shuffleOptions());
      db.prepare('UPDATE session_items SET option_order = ?, started_at = ?, deadline_at = ? WHERE session_id = ? AND position = ?')
        .run(order, startedAt, deadlineAt, session.id, item.position);
      item = { ...item, option_order: order, started_at: startedAt, deadline_at: deadlineAt };
    }
    if (now >= item.deadline_at!) {
      finishAttempt(db, session, item, 'timeout', null, now);
      session = { ...session, phase: 'feedback' };
    }
  }
  const total = (db.prepare('SELECT COUNT(*) AS count FROM session_items WHERE session_id = ?')
    .get(session.id) as { count: number }).count;
  if (session.phase === 'feedback') {
    return {
      id: session.id,
      targetCount: session.target_count,
      total,
      position: item.position + 1,
      phase: 'feedback',
      feedback: feedbackFor(db, item),
    };
  }
  return {
    id: session.id,
    targetCount: session.target_count,
    total,
    position: item.position + 1,
    phase: 'question',
    question: visibleQuestion(db, item),
  };
}

export function getActiveView(db: Db, now: number): SessionView | null {
  return db.transaction(() => {
    const session = activeSession(db);
    return session ? renderSession(db, session, now) : null;
  })();
}

function checkPosition(session: SessionRow, expectedPosition?: number): void {
  if (expectedPosition !== undefined && expectedPosition !== session.cursor_position + 1) {
    throw new DomainError('当前题已在另一个页面更新，请刷新后继续。', 409);
  }
}

export function submitAnswer(db: Db, id: string, selectedLabel: unknown, now: number, expectedPosition?: number): SessionView {
  if (!isOptionLetter(selectedLabel)) throw new DomainError('请选择 A、B、C 或 D。');
  return db.transaction(() => {
    const session = activeSession(db, id);
    if (!session) throw new DomainError('该轮答题不在进行中。', 409);
    checkPosition(session, expectedPosition);
    const current = renderSession(db, session, now);
    if (current.phase === 'feedback') return current;
    const item = itemAt(db, session);
    const selectedOriginal = orderOf(item)[optionLetters.indexOf(selectedLabel)];
    finishAttempt(db, session, item, selectedOriginal === item.answer ? 'correct' : 'wrong', selectedLabel, now);
    return renderSession(db, { ...session, phase: 'feedback' }, now);
  })();
}

export function nextQuestion(db: Db, id: string, now: number, expectedPosition?: number): { session: SessionView | null; summaryId: string | null } {
  return db.transaction(() => {
    const session = activeSession(db, id);
    if (!session) throw new DomainError('该轮答题不在进行中。', 409);
    checkPosition(session, expectedPosition);
    const current = renderSession(db, session, now);
    if (current.phase !== 'feedback') throw new DomainError('请先完成当前题目。', 409);
    if (session.cursor_position + 1 >= current.total) {
      db.prepare("UPDATE sessions SET status = 'completed', ended_at = ? WHERE id = ?").run(now, id);
      return { session: null, summaryId: id };
    }
    db.prepare("UPDATE sessions SET cursor_position = cursor_position + 1, phase = 'question' WHERE id = ?").run(id);
    return { session: renderSession(db, { ...session, cursor_position: session.cursor_position + 1, phase: 'question' }, now), summaryId: null };
  })();
}

export function endSession(db: Db, id: string, now: number, expectedPosition?: number): string {
  return db.transaction(() => {
    const session = activeSession(db, id);
    if (!session) throw new DomainError('该轮答题不在进行中。', 409);
    checkPosition(session, expectedPosition);
    if (session.phase === 'question') {
      const item = itemAt(db, session);
      if (item.started_at !== null) {
        finishAttempt(db, session, item, now >= item.deadline_at! ? 'timeout' : 'abandoned', null, now);
      }
    }
    db.prepare("UPDATE sessions SET status = 'ended', ended_at = ? WHERE id = ?").run(now, id);
    return id;
  })();
}

export function getSessionSummary(db: Db, id: string): SessionSummary {
  const session = db.prepare('SELECT id, status, started_at, ended_at, target_count FROM sessions WHERE id = ?')
    .get(id) as (SessionRow & { target_count: number }) | undefined;
  if (!session || session.status === 'active' || session.ended_at === null) {
    throw new DomainError('找不到已经结束的答题总结。', 404);
  }
  const plannedCount = (db.prepare('SELECT COUNT(*) AS count FROM session_items WHERE session_id = ?')
    .get(id) as { count: number }).count;
  const rows = db.prepare('SELECT phase, status, duration_ms FROM attempts WHERE session_id = ?')
    .all(id) as Array<{ phase: AttemptPhase; status: AttemptStatus; duration_ms: number }>;
  function score(phase: AttemptPhase): Score {
    const attempts = rows.filter((row) => row.phase === phase);
    return {
      correct: attempts.filter((row) => row.status === 'correct').length,
      total: attempts.length,
      averageMs: attempts.length
        ? Math.round(attempts.reduce((sum, row) => sum + row.duration_ms, 0) / attempts.length)
        : null,
    };
  }
  return {
    id,
    status: session.status,
    startedAt: session.started_at,
    endedAt: session.ended_at,
    targetCount: session.target_count,
    plannedCount,
    attemptedCount: rows.length,
    first: score('first'),
    review: score('review'),
    timeoutCount: rows.filter((row) => row.status === 'timeout').length,
    abandonedCount: rows.filter((row) => row.status === 'abandoned').length,
  };
}
