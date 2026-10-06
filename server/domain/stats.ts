import type { AttemptHistory, AttemptPhase, AttemptStatus, Score, Stats } from '../../shared/api';
import type { OptionLetter } from '../../shared/question';
import type { Db } from '../db';
import { getSessionSummary } from './session';

type StatAttempt = {
  phase: AttemptPhase;
  status: AttemptStatus;
  duration_ms: number;
  completed_at: number;
  language: string;
  topic: string;
};

function score(rows: StatAttempt[], phase: AttemptPhase): Score {
  const relevant = rows.filter((row) => row.phase === phase);
  return {
    correct: relevant.filter((row) => row.status === 'correct').length,
    total: relevant.length,
    averageMs: relevant.length
      ? Math.round(relevant.reduce((sum, row) => sum + row.duration_ms, 0) / relevant.length)
      : null,
  };
}

function localDay(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function getStats(db: Db, now: number): Stats {
  const questionRows = db.prepare(`
    SELECT q.language, q.topic, r.state, r.due_at
    FROM questions q JOIN review_state r ON r.question_id = q.id
  `).all() as Array<{ language: string; topic: string; state: string; due_at: number | null }>;
  const attempts = db.prepare(`
    SELECT a.phase, a.status, a.duration_ms, a.completed_at, q.language, q.topic
    FROM attempts a JOIN questions q ON q.id = a.question_id
  `).all() as StatAttempt[];
  const byTopic = new Map<string, { language: string; topic: string; attempts: StatAttempt[] }>();
  for (const { language, topic } of questionRows) {
    const key = JSON.stringify([language, topic]);
    if (!byTopic.has(key)) byTopic.set(key, { language, topic, attempts: [] });
  }
  const byDay = new Map<string, StatAttempt[]>();
  for (const attempt of attempts) {
    byTopic.get(JSON.stringify([attempt.language, attempt.topic]))?.attempts.push(attempt);
    const day = localDay(attempt.completed_at);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(attempt);
  }

  const history = db.prepare(`
    SELECT a.id, a.question_id, q.language, q.topic, q.stem, a.phase, a.status,
      a.selected_label, a.completed_at, a.duration_ms, a.session_id
    FROM attempts a JOIN questions q ON q.id = a.question_id
    ORDER BY a.completed_at DESC, a.rowid DESC LIMIT 100
  `).all() as Array<{
    id: string; question_id: string; language: string; topic: string; stem: string;
    phase: AttemptPhase; status: AttemptStatus; selected_label: OptionLetter | null;
    completed_at: number; duration_ms: number; session_id: string;
  }>;
  const recentSessions = db.prepare(`
    SELECT id FROM sessions WHERE status != 'active' ORDER BY ended_at DESC LIMIT 12
  `).all() as Array<{ id: string }>;
  const intervalHours = (db.prepare('SELECT interval_hours FROM settings WHERE id = 1')
    .get() as { interval_hours: number }).interval_hours;
  const waiting = questionRows.filter((row) => row.state === 'once_due' || row.state === 'retry_due');
  const future = waiting.map((row) => row.due_at!).filter((dueAt) => dueAt > now);

  return {
    questions: {
      total: questionRows.length,
      new: questionRows.filter((row) => row.state === 'new').length,
      due: waiting.filter((row) => row.due_at! <= now).length,
      waiting: waiting.filter((row) => row.due_at! > now).length,
      done: questionRows.filter((row) => row.state === 'done').length,
      nextDueAt: future.length ? Math.min(...future) : null,
    },
    first: score(attempts, 'first'),
    review: score(attempts, 'review'),
    byTopic: [...byTopic.values()]
      .map(({ language, topic, attempts: rows }) => ({ language, topic, first: score(rows, 'first'), review: score(rows, 'review') }))
      .sort((a, b) => a.language.localeCompare(b.language) || a.topic.localeCompare(b.topic)),
    byDay: [...byDay.entries()].map(([day, rows]) => ({ day, first: score(rows, 'first'), review: score(rows, 'review') }))
      .sort((a, b) => b.day.localeCompare(a.day)).slice(0, 30),
    history: history.map((row): AttemptHistory => ({
      id: row.id,
      questionId: row.question_id,
      language: row.language,
      topic: row.topic,
      stem: row.stem,
      phase: row.phase,
      status: row.status,
      selectedLabel: row.selected_label,
      completedAt: row.completed_at,
      elapsedMs: row.duration_ms,
      sessionId: row.session_id,
    })),
    sessions: recentSessions.map(({ id }) => getSessionSummary(db, id)),
    languages: [...new Set(questionRows.map((row) => row.language))].sort(),
    topics: [...new Set(questionRows.map((row) => row.topic))].sort(),
    intervalHours,
  };
}
