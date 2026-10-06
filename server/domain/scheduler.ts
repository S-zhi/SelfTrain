import { randomUUID } from 'node:crypto';
import type { Db } from '../db';
import { DomainError } from './errors';

export interface SessionFilter {
  language?: string | null;
  topic?: string | null;
}

export interface StartResult {
  id: string | null;
  total: number;
  nextDueAt: number | null;
}

export function startSession(db: Db, filter: SessionFilter, now: number): StartResult {
  const language = filter.language || null;
  const topic = filter.topic || null;

  return db.transaction(() => {
    const active = db.prepare("SELECT id FROM sessions WHERE status = 'active'").get();
    if (active) throw new DomainError('已有进行中的答题，请先继续或结束该轮。', 409);

    const candidates = db.prepare(`
      SELECT q.id, r.state
      FROM questions q JOIN review_state r ON r.question_id = q.id
      WHERE (? IS NULL OR q.language = ?)
        AND (? IS NULL OR q.topic = ?)
        AND (r.state = 'new' OR (r.state IN ('once_due','retry_due') AND r.due_at <= ?))
      ORDER BY CASE WHEN r.state = 'new' THEN 1 ELSE 0 END,
        CASE WHEN r.state = 'new' THEN NULL ELSE r.due_at END,
        RANDOM()
      LIMIT 30
    `).all(language, language, topic, topic, now) as Array<{ id: string; state: string }>;

    if (!candidates.length) {
      const next = db.prepare(`
        SELECT MIN(r.due_at) AS next_due
        FROM review_state r JOIN questions q ON q.id = r.question_id
        WHERE r.state IN ('once_due','retry_due') AND r.due_at > ?
          AND (? IS NULL OR q.language = ?)
          AND (? IS NULL OR q.topic = ?)
      `).get(now, language, language, topic, topic) as { next_due: number | null };
      return { id: null, total: 0, nextDueAt: next.next_due };
    }

    const id = randomUUID();
    db.prepare(`
      INSERT INTO sessions (id, status, phase, cursor_position, target_count,
        language_filter, topic_filter, started_at)
      VALUES (?, 'active', 'question', 0, 30, ?, ?, ?)
    `).run(id, language, topic, now);
    const insertItem = db.prepare(`
      INSERT INTO session_items (session_id, position, question_id, phase)
      VALUES (?, ?, ?, ?)
    `);
    for (const [position, candidate] of candidates.entries()) {
      insertItem.run(id, position, candidate.id, candidate.state === 'new' ? 'first' : 'review');
    }
    return { id, total: candidates.length, nextDueAt: null };
  })();
}
