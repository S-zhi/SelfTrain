import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../server/db';
import { openDatabase } from '../server/db';
import { DomainError } from '../server/domain/errors';
import { importQuestions } from '../server/domain/import';

const now = 1_760_000_000_000;

function question(id: string) {
  return {
    id, language: 'Go', topic: '语法', stem: `题目 ${id}`,
    options: { A: `正确-${id}`, B: `错一-${id}`, C: `错二-${id}`, D: `错三-${id}` },
    answer: 'A', explanation: 'A 是正确答案。', duration_seconds: 30,
  };
}

function questionLines(count: number): string[] {
  return Array.from({ length: count }, (_, index) => JSON.stringify(question(`limit-${String(index).padStart(5, '0')}`)));
}

function rowCount(db: Db, table: 'questions' | 'review_state'): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

describe('JSONL 导入题目数量上限', () => {
  let db: Db | undefined;
  afterEach(() => { db?.close(); db = undefined; });

  it('接受 5000 道非空题目，空行、BOM、CRLF 和末尾换行不额外计数', () => {
    db = openDatabase(':memory:');
    const lines = questionLines(5000);
    lines.splice(1, 0, '', '  ');
    const result = importQuestions(db, `\uFEFF${lines.join('\r\n')}\r\n`, now);

    expect(result).toEqual({ imported: 5000, skipped: 0, total: 5000 });
    expect(rowCount(db, 'questions')).toBe(5000);
    expect(rowCount(db, 'review_state')).toBe(5000);
  });

  it.each([true, false])('拒绝 5001 道非空题目（末尾换行：%s），并保留原数据与物理行号', (trailingNewline) => {
    db = openDatabase(':memory:');
    importQuestions(db, JSON.stringify(question('existing')), now);
    const lines = questionLines(5001);
    lines.splice(1, 0, '', '  ');
    const jsonl = `${lines.join('\n')}${trailingNewline ? '\n' : ''}`;
    let caught: unknown;
    try {
      importQuestions(db, jsonl, now);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DomainError);
    expect((caught as DomainError).message).toContain('5000');
    expect((caught as DomainError).message).toContain('未写入');
    expect((caught as DomainError).details).toContain('第 5003 行：这是第 5001 道非空题目，超出单次导入上限。');
    expect(rowCount(db, 'questions')).toBe(1);
    expect(rowCount(db, 'review_state')).toBe(1);
    expect(db.prepare('SELECT id FROM questions').get()).toEqual({ id: 'existing' });
  });
});
