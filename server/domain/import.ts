import { createHash } from 'node:crypto';
import type { ImportResult } from '../../shared/api';
import { questionSchema, type QuestionInput } from '../../shared/question';
import type { Db } from '../db';
import { DomainError } from './errors';

interface ParsedLine {
  line: number;
  value: QuestionInput;
  hash: string;
}

function canonicalQuestion(value: QuestionInput) {
  return {
    id: value.id,
    language: value.language,
    topic: value.topic,
    stem: value.stem,
    options: {
      A: value.options.A,
      B: value.options.B,
      C: value.options.C,
      D: value.options.D,
    },
    answer: value.answer,
    explanation: value.explanation,
    duration_seconds: value.duration_seconds,
    tags: value.tags ?? [],
    go_version: value.go_version ?? null,
  };
}

export function questionHash(value: QuestionInput): string {
  return createHash('sha256').update(JSON.stringify(canonicalQuestion(value))).digest('hex');
}

function parseLines(jsonl: string): ParsedLine[] {
  const lines = jsonl.replace(/^﻿/, '').split(/\r?\n/);
  const errors: string[] = [];
  const parsed: ParsedLine[] = [];
  const seen = new Map<string, { line: number; hash: string }>();

  let questionLines = 0;
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    questionLines += 1;
    if (questionLines > 5000) {
      throw new DomainError('单次最多导入 5000 道非空题目，未写入任何题目。', 400, [
        `第 ${index + 1} 行：这是第 5001 道非空题目，超出单次导入上限。`,
      ]);
    }
  }

  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      errors.push(`第 ${index + 1} 行：不是有效的 JSON。`);
      continue;
    }
    const checked = questionSchema.safeParse(raw);
    if (!checked.success) {
      const descriptions = checked.error.issues.map((issue) => `${issue.path.join('.') || '题目'}：${issue.message}`);
      errors.push(`第 ${index + 1} 行：${descriptions.join('；')}`);
      continue;
    }
    const value = checked.data;
    const hash = questionHash(value);
    const previous = seen.get(value.id);
    if (previous && previous.hash !== hash) {
      errors.push(`第 ${index + 1} 行：ID ${value.id} 与第 ${previous.line} 行的内容冲突。`);
    } else {
      seen.set(value.id, { line: index + 1, hash });
      parsed.push({ line: index + 1, value, hash });
    }
  }

  if (errors.length) throw new DomainError('导入失败，没有写入任何题目。', 400, errors.slice(0, 30));
  if (!parsed.length) throw new DomainError('文件里没有题目，请检查 JSONL 内容。');
  return parsed;
}

export function importQuestions(db: Db, jsonl: string, now: number): ImportResult {
  if (typeof jsonl !== 'string') throw new DomainError('请选择 JSONL 文本文件。');
  if (Buffer.byteLength(jsonl, 'utf8') > 5 * 1024 * 1024) {
    throw new DomainError('JSONL 文件不能超过 5 MB。');
  }
  const parsed = parseLines(jsonl);
  const existing = db.prepare('SELECT content_hash FROM questions WHERE id = ?');
  const insert = db.prepare(`
    INSERT INTO questions (id, content_hash, language, topic, stem, options_json, answer,
      explanation, duration_seconds, tags_json, go_version, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertState = db.prepare("INSERT INTO review_state (question_id, state) VALUES (?, 'new')");

  return db.transaction(() => {
    let imported = 0;
    let skipped = 0;
    for (const { line, value, hash } of parsed) {
      const previous = existing.get(value.id) as { content_hash: string } | undefined;
      if (previous) {
        if (previous.content_hash !== hash) {
          throw new DomainError('导入失败，没有写入任何题目。', 409, [
            `第 ${line} 行：ID ${value.id} 已存在，但内容不同。请为修改后的题目分配新 ID。`,
          ]);
        }
        skipped += 1;
        continue;
      }
      insert.run(
        value.id, hash, value.language, value.topic, value.stem,
        JSON.stringify(value.options), value.answer, value.explanation,
        value.duration_seconds, JSON.stringify(value.tags ?? []), value.go_version ?? null, now,
      );
      insertState.run(value.id);
      imported += 1;
    }
    return { imported, skipped, total: parsed.length };
  })();
}
