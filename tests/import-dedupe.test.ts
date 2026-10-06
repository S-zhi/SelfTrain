import { describe, expect, it } from 'vitest';
import { openDatabase } from '../server/db';
import { importQuestions, dedupeHash } from '../server/domain/import';
import { exportBackup, restoreBackup } from '../server/domain/backup';
import { questionSchema } from '../shared/question';

const question = (id: string, overrides: Record<string, unknown> = {}) => ({ id, language: ' Go ', topic: '基础', stem: ' 题目 ',
  options: { A: '正确', B: '错误一', C: '错误二', D: '错误三' }, answer: 'A', explanation: '解释', duration_seconds: 30, ...overrides });

describe('多文件内容去重导入', () => {
  it('按规范化业务内容去重并报告跨文件位置；同 ID 冲突优先整批拒绝', () => {
    const db = openDatabase(':memory:');
    try {
      const result = importQuestions(db, [
        { name: 'a.jsonl', jsonl: JSON.stringify(question('one')) },
        { name: 'b.jsonl', jsonl: `\uFEFF\n${JSON.stringify(question('two', { language: 'Go', stem: '题目' }))}\r\n${JSON.stringify(question('three'))}` },
      ], 10);
      expect(result).toEqual({ imported: 1, skipped: 2, total: 3, duplicates: [
        { file: 'b.jsonl', line: 2, reason: 'content', matchedFile: 'a.jsonl', matchedLine: 1 },
        { file: 'b.jsonl', line: 3, reason: 'content', matchedFile: 'a.jsonl', matchedLine: 1 },
      ] });
      expect((db.prepare('SELECT COUNT(*) count FROM review_state').get() as { count: number }).count).toBe(1);
      expect(() => importQuestions(db, [
        { name: 'conflict.jsonl', jsonl: JSON.stringify(question('different-id')) },
        { name: 'conflict.jsonl', jsonl: JSON.stringify(question('different-id', { explanation: '改过' })) },
      ], 11)).toThrow(/没有写入/);
      expect((db.prepare('SELECT COUNT(*) count FROM questions').get() as { count: number }).count).toBe(1);
    } finally { db.close(); }
  });

  it('库内跨 ID 重复和人为哈希碰撞均跳过且保留复习状态', () => {
    const db = openDatabase(':memory:');
    try {
      importQuestions(db, JSON.stringify(question('original')), 10);
      db.prepare("UPDATE review_state SET state = 'once_due', due_at = 999, last_attempt_at = 888 WHERE question_id = 'original'").run();
      const before = db.prepare('SELECT * FROM review_state WHERE question_id = ?').get('original');
      const duplicate = importQuestions(db, JSON.stringify(question('new-id')), 11);
      expect(duplicate).toMatchObject({ imported: 0, skipped: 1, total: 1 });
      expect(db.prepare('SELECT * FROM review_state WHERE question_id = ?').get('original')).toEqual(before);
      expect(db.prepare('SELECT COUNT(*) AS count FROM questions').get()).toEqual({ count: 1 });

      const collisionCandidate = question('collision', { stem: '不同业务内容', options: { A: '正确', B: '错误一', C: '错误二', D: '错误三' } });
      db.prepare('UPDATE questions SET dedupe_hash = ? WHERE id = ?').run(dedupeHash(questionSchema.parse(collisionCandidate)), 'original');
      expect(importQuestions(db, JSON.stringify(collisionCandidate), 12)).toMatchObject({ imported: 0, skipped: 1, total: 1 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM questions').get()).toEqual({ count: 1 });
      expect(db.prepare('SELECT * FROM review_state WHERE question_id = ?').get('original')).toEqual(before);
    } finally { db.close(); }
  });

  it('v1 格式备份恢复后仍阻止换 ID 的相同内容', () => {
    const db = openDatabase(':memory:');
    try {
      importQuestions(db, JSON.stringify(question('before-backup')), 10);
      const backup = exportBackup(db, 20);
      expect(backup.version).toBe(1);
      expect(Object.keys(backup.data.questions[0])).not.toContain('dedupe_hash');
      restoreBackup(db, backup);
      expect(importQuestions(db, JSON.stringify(question('after-restore')), 30)).toMatchObject({ imported: 0, skipped: 1 });
      expect(db.prepare('SELECT id FROM questions').all()).toEqual([{ id: 'before-backup' }]);
    } finally { db.close(); }
  });
});
