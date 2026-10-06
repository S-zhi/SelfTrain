import { createHash } from 'node:crypto';
import type { ImportFile, ImportResult } from '../../shared/api';
import { questionSchema, type QuestionInput } from '../../shared/question';
import type { Db } from '../db';
import { DomainError } from './errors';

interface ParsedLine { file: string; fileIndex: number; line: number; value: QuestionInput; hash: string; dedupeHash: string }
function canonicalQuestion(value: QuestionInput, includeId: boolean) {
  return {
    ...(includeId ? { id: value.id } : {}), language: value.language, topic: value.topic, stem: value.stem,
    options: { A: value.options.A, B: value.options.B, C: value.options.C, D: value.options.D },
    answer: value.answer, explanation: value.explanation, duration_seconds: value.duration_seconds,
    tags: value.tags ?? [], go_version: value.go_version ?? null,
  };
}
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function questionHash(value: QuestionInput): string { return sha(canonicalQuestion(value, true)); }
export function dedupeHash(value: QuestionInput): string { return sha(canonicalQuestion(value, false)); }

function parseFiles(files: ImportFile[], legacySingle = false): ParsedLine[] {
  let byteCount = 0;
  const parsed: ParsedLine[] = [];
  const errors: string[] = [];
  let count = 0;
  const names = new Map<string, number>();
  for (const [fileIndex, file] of files.entries()) {
    const duplicateCount = (names.get(file.name) ?? 0) + 1;
    names.set(file.name, duplicateCount);
    const displayName = duplicateCount === 1 ? file.name : `${file.name}（文件 ${fileIndex + 1}）`;
    byteCount += Buffer.byteLength(file.jsonl, 'utf8');
    if (byteCount > 5 * 1024 * 1024) throw new DomainError('单次导入的 JSONL 文本合计不能超过 5 MB。');
    const lines = file.jsonl.replace(/^\uFEFF/, '').split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      count += 1;
      if (count > 5000) throw new DomainError('单次最多导入 5000 道非空题目，未写入任何题目。', 400,
        [legacySingle ? `第 ${index + 1} 行：这是第 5001 道非空题目，超出单次导入上限。` : `${displayName} 第 ${index + 1} 行：这是第 5001 道非空题目，超出单次导入上限。`]);
      let raw: unknown;
      try { raw = JSON.parse(line); } catch { errors.push(`${displayName} 第 ${index + 1} 行：不是有效的 JSON。`); continue; }
      const checked = questionSchema.safeParse(raw);
      if (!checked.success) {
        errors.push(`${displayName} 第 ${index + 1} 行：${checked.error.issues.map((issue) => `${issue.path.join('.') || '题目'}：${issue.message}`).join('；')}`);
        continue;
      }
      const value = checked.data;
      parsed.push({ file: displayName, fileIndex, line: index + 1, value, hash: questionHash(value), dedupeHash: dedupeHash(value) });
    }
  }
  if (errors.length) throw new DomainError('导入失败，没有写入任何题目。', 400, errors.slice(0, 30));
  if (!parsed.length) throw new DomainError('文件里没有题目，请检查 JSONL 内容。');
  const ids = new Map<string, ParsedLine>();
  for (const item of parsed) {
    const prior = ids.get(item.value.id);
    if (prior && prior.hash !== item.hash) errors.push(`${item.file} 第 ${item.line} 行：ID ${item.value.id} 与 ${prior.file} 第 ${prior.line} 行的内容冲突。`);
    else if (!prior) ids.set(item.value.id, item);
  }
  if (errors.length) throw new DomainError('导入失败，没有写入任何题目。', 409, errors.slice(0, 30));
  return parsed;
}

export function importQuestions(db: Db, input: string | ImportFile[], now: number): ImportResult {
  const legacySingle = typeof input === 'string';
  const files = typeof input === 'string' ? [{ name: '导入文件.jsonl', jsonl: input }] : input;
  if (!files.length || files.some((file) => !file || typeof file.name !== 'string' || typeof file.jsonl !== 'string')) throw new DomainError('请选择 JSONL 文本文件。');
  const parsed = parseFiles(files, legacySingle);
  const insert = db.prepare(`INSERT INTO questions (id, content_hash, dedupe_hash, language, topic, stem, options_json, answer, explanation, duration_seconds, tags_json, go_version, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertState = db.prepare("INSERT INTO review_state (question_id, state) VALUES (?, 'new')");
  return db.transaction(() => {
    const idToHash = new Map<string, string>();
    const idExisting = db.prepare('SELECT content_hash FROM questions WHERE id = ?');
    for (const item of parsed) {
      const previous = idExisting.get(item.value.id) as { content_hash: string } | undefined;
      if (previous && previous.content_hash !== item.hash) throw new DomainError('导入失败，没有写入任何题目。', 409,
        [`${item.file} 第 ${item.line} 行：ID ${item.value.id} 已存在，但内容不同。请为修改后的题目分配新 ID。`]);
    }
    const known = new Map<string, { id: string } | { file: string; line: number }>();
    for (const row of db.prepare('SELECT id, dedupe_hash FROM questions').all() as Array<{ id: string; dedupe_hash: string }>) known.set(row.dedupe_hash, { id: row.id });
    const duplicates: ImportResult['duplicates'] = [];
    const addedIds = new Map<string, { file: string; line: number }>();
    let imported = 0;
    for (const item of parsed) {
      if (idToHash.has(item.value.id) || idExisting.get(item.value.id)) {
        duplicates.push({ file: item.file, line: item.line, reason: 'id', matchedId: item.value.id }); continue;
      }
      const match = known.get(item.dedupeHash);
      if (match) { duplicates.push({ file: item.file, line: item.line, reason: 'content', ...('id' in match ? { matchedId: match.id } : { matchedFile: match.file, matchedLine: match.line }) }); continue; }
      const prior = addedIds.get(item.dedupeHash);
      if (prior) { duplicates.push({ file: item.file, line: item.line, reason: 'content', matchedFile: prior.file, matchedLine: prior.line }); continue; }
      const { value } = item;
      insert.run(value.id, item.hash, item.dedupeHash, value.language, value.topic, value.stem, JSON.stringify(value.options), value.answer,
        value.explanation, value.duration_seconds, JSON.stringify(value.tags ?? []), value.go_version ?? null, now);
      insertState.run(value.id); imported += 1; idToHash.set(value.id, item.hash); addedIds.set(item.dedupeHash, { file: item.file, line: item.line });
      known.set(item.dedupeHash, { file: item.file, line: item.line });
    }
    return { imported, skipped: duplicates.length, total: parsed.length, ...(duplicates.length ? { duplicates } : {}) };
  })();
}
