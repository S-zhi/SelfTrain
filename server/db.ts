import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type Db = Database.Database;

export function databasePath(): string {
  return join(process.env.SELFTRAIN_DATA_DIR ?? join(process.cwd(), 'data'), 'selftrain.sqlite');
}

export function openDatabase(filePath = databasePath()): Db {
  if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true });

  const db = new Database(filePath);
  db.pragma('foreign_keys = ON');
  if (filePath !== ':memory:') db.pragma('journal_mode = WAL');

  const version = db.pragma('user_version', { simple: true }) as number;
  if (version > 1) {
    db.close();
    throw new Error('数据库来自更新版本的 SelfTrain；请使用相应版本启动。');
  }
  if (version === 0) {
    db.transaction(() => db.exec(`
      CREATE TABLE questions (
        id TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        language TEXT NOT NULL,
        topic TEXT NOT NULL,
        stem TEXT NOT NULL,
        options_json TEXT NOT NULL,
        answer TEXT NOT NULL CHECK (answer IN ('A','B','C','D')),
        explanation TEXT NOT NULL,
        duration_seconds INTEGER NOT NULL CHECK (duration_seconds BETWEEN 1 AND 3600),
        tags_json TEXT NOT NULL,
        go_version TEXT,
        imported_at INTEGER NOT NULL
      );
      CREATE TABLE review_state (
        question_id TEXT PRIMARY KEY REFERENCES questions(id),
        state TEXT NOT NULL CHECK (state IN ('new','once_due','retry_due','done')),
        due_at INTEGER,
        last_attempt_at INTEGER
      );
      CREATE INDEX review_due ON review_state(state, due_at);
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('active','completed','ended')),
        phase TEXT NOT NULL CHECK (phase IN ('question','feedback')),
        cursor_position INTEGER NOT NULL DEFAULT 0,
        target_count INTEGER NOT NULL DEFAULT 30,
        language_filter TEXT,
        topic_filter TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER
      );
      CREATE UNIQUE INDEX only_one_active_session ON sessions(status) WHERE status = 'active';
      CREATE TABLE session_items (
        session_id TEXT NOT NULL REFERENCES sessions(id),
        position INTEGER NOT NULL,
        question_id TEXT NOT NULL REFERENCES questions(id),
        phase TEXT NOT NULL CHECK (phase IN ('first','review')),
        option_order TEXT,
        started_at INTEGER,
        deadline_at INTEGER,
        PRIMARY KEY (session_id, position),
        UNIQUE (session_id, question_id)
      );
      CREATE TABLE attempts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        position INTEGER NOT NULL,
        question_id TEXT NOT NULL REFERENCES questions(id),
        phase TEXT NOT NULL CHECK (phase IN ('first','review')),
        status TEXT NOT NULL CHECK (status IN ('correct','wrong','timeout','abandoned')),
        selected_label TEXT,
        selected_original TEXT,
        option_order TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        UNIQUE (session_id, position)
      );
      CREATE INDEX attempts_completed ON attempts(completed_at DESC);
      CREATE INDEX attempts_question ON attempts(question_id);
      CREATE TABLE settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        interval_hours INTEGER NOT NULL CHECK (interval_hours BETWEEN 1 AND 720)
      );
      INSERT INTO settings (id, interval_hours) VALUES (1, 24);
      PRAGMA user_version = 1;
    `))();
  }
  return db;
}
