import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../server/db';

it('v1 升级会规范化回填并保留历史重复题及 ID', () => {
  const dir = mkdtempSync(join(tmpdir(), 'selftrain-v1-'));
  const file = join(dir, 'old.sqlite');
  const old = new Database(file);
  old.exec(`CREATE TABLE questions (id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, language TEXT NOT NULL, topic TEXT NOT NULL, stem TEXT NOT NULL, options_json TEXT NOT NULL, answer TEXT NOT NULL, explanation TEXT NOT NULL, duration_seconds INTEGER NOT NULL, tags_json TEXT NOT NULL, go_version TEXT, imported_at INTEGER NOT NULL);
    INSERT INTO questions VALUES ('old-a','x','Go','topic','stem','{"D":"d","B":"b","A":"a","C":"c"}','A','e',30,'[]',NULL,1);
    INSERT INTO questions VALUES ('old-b','y','Go','topic','stem','{"C":"c","A":"a","D":"d","B":"b"}','A','e',30,'[]',NULL,1);
    PRAGMA user_version = 1;`);
  old.close();
  try {
    const db = openDatabase(file);
    try {
      expect(db.pragma('user_version', { simple: true })).toBe(2);
      expect(db.prepare('SELECT id FROM questions ORDER BY id').all()).toEqual([{ id: 'old-a' }, { id: 'old-b' }]);
      expect(db.prepare('SELECT COUNT(DISTINCT dedupe_hash) AS count FROM questions').get()).toEqual({ count: 1 });
      expect(db.prepare('PRAGMA index_list(questions)').all()).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'questions_dedupe_hash', unique: 0 })]));
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
