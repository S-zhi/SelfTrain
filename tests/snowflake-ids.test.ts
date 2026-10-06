import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allocateIds, validateState } from '../tools/snowflake-core.mjs';
import { questionSchema } from '../shared/question';

const run = promisify(execFile);
const script = resolve('tools/assign-snowflake-ids.mjs');
const draft = JSON.stringify({ id: 'draft-1', language: 'Go', topic: 't', stem: 's', options: { A: 'a', B: 'b', C: 'c', D: 'd' }, answer: 'A', explanation: 'e', duration_seconds: 30 }) + '\n';
const invoke = (dir: string, config: string, output: string, input = 'draft.jsonl') => run(process.execPath, [script, '--agent-id', '42', '--input', join(dir, input), '--output', join(dir, output), '--config', config]);

describe('Snowflake ID 分配工具', () => {
  it('重启后继续递增；并发进程共享锁与持久状态，不分配重复 ID', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'selftrain-ids-'));
    try {
      writeFileSync(join(dir, 'draft.jsonl'), draft);
      const config = join(dir, 'state.json');
      await invoke(dir, config, 'first.jsonl');
      await invoke(dir, config, 'second.jsonl');
      await Promise.all([invoke(dir, config, 'third.jsonl'), invoke(dir, config, 'fourth.jsonl')]);
      const ids = ['first', 'second', 'third', 'fourth'].map((name) => JSON.parse(readFileSync(join(dir, `${name}.jsonl`), 'utf8')).id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.every((id) => /^\d+$/.test(id))).toBe(true);
      expect(JSON.parse(readFileSync(config, 'utf8')).agentId).toBe(42);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('检测时钟回拨和损坏状态并停止生成', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'selftrain-ids-clock-'));
    try {
      writeFileSync(join(dir, 'draft.jsonl'), draft);
      const config = join(dir, 'state.json');
      writeFileSync(config, JSON.stringify({ agentId: 42, lastTime: Date.now() + 60_000, sequence: 0 }));
      await expect(invoke(dir, config, 'rollback.jsonl')).rejects.toThrow(/时钟回拨/);
      writeFileSync(config, JSON.stringify({ agentId: 42, lastTime: '坏', sequence: -8 }));
      await expect(invoke(dir, config, 'corrupt.jsonl')).rejects.toThrow(/状态文件损坏/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('同毫秒序列达到上限后等到下一毫秒继续分配', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'selftrain-ids-seq-'));
    try {
      writeFileSync(join(dir, 'draft.jsonl'), draft);
      const config = join(dir, 'state.json');
      writeFileSync(config, JSON.stringify({ agentId: 42, lastTime: Date.now(), sequence: 4095 }));
      await invoke(dir, config, 'next.jsonl');
      expect(JSON.parse(readFileSync(config, 'utf8')).sequence).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('可控时钟验证回拨中止和序列耗尽后等待下一毫秒', async () => {
    const now = Date.now();
    const rollbackClock = [now, now - 1];
    await expect(allocateIds(2, { agentId: 42, lastTime: now - 2, sequence: 0 }, 42, () => rollbackClock.shift()!))
      .rejects.toThrow(/时钟回拨/);
    let ticks = 0;
    const allocated = await allocateIds(1, { agentId: 42, lastTime: now, sequence: 4095 }, 42,
      () => now + ticks, async () => { ticks += 1; });
    expect(allocated.state).toEqual({ agentId: 42, lastTime: now + 1, sequence: 0 });
    expect(BigInt(allocated.ids[0]) >> 22n).toBe(BigInt(now + 1 - Date.UTC(2024, 0, 1)));
  });

  it('拒绝缺字段和非数字的历史状态，不把损坏状态重置成新状态', () => {
    expect(() => validateState({ agentId: 42 }, 42)).toThrow(/状态文件损坏/);
    expect(() => validateState({ agentId: 42, lastTime: '123', sequence: 0 }, 42)).toThrow(/状态文件损坏/);
  });

  it('对替换 ID 后的 UTF-8 输出执行 5 MiB 上限检查，失败不推进状态', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'selftrain-ids-size-'));
    try {
      const limit = 5 * 1024 * 1024;
      const count = 5000;
      const question = (id: string, stem = '') => ({ id, language: 'Go', topic: '测试', stem,
        options: { A: '正确', B: '错误一', C: '错误二', D: '错误三' }, answer: 'A', explanation: '解析', duration_seconds: 30 });
      const draftToTargetBytes = (targetBytes: number, idLength: number) => {
        const ids = Array.from({ length: count }, (_, index) => `draft-${String(index).padStart(5, '0')}`);
        const base = ids.map(() => JSON.stringify(question('9'.repeat(idLength)))).join('\n') + '\n';
        const paddingBytes = targetBytes - Buffer.byteLength(base, 'utf8');
        const charsPerLine = Math.floor(paddingBytes / (count * 3));
        const remainingBytes = paddingBytes - charsPerLine * count * 3;
        const rows = ids.map((id, index) => {
          const asciiPadding = Math.floor(remainingBytes / count) + (index < remainingBytes % count ? 1 : 0);
          return JSON.stringify(question(id, '题'.repeat(charsPerLine) + 'x'.repeat(asciiPadding)));
        });
        for (const row of rows) questionSchema.parse(JSON.parse(row));
        return rows.join('\n') + '\n';
      };
      writeFileSync(join(dir, 'draft.jsonl'), JSON.stringify({ id: 'draft', language: 'Go', topic: 't', stem: 's', options: { A: 'a', B: 'b', C: 'c', D: 'd' }, answer: 'A', explanation: 'e', duration_seconds: 30 }) + '\n');
      await invoke(dir, join(dir, 'sample-state.json'), 'sample.jsonl');
      const id = JSON.parse(readFileSync(join(dir, 'sample.jsonl'), 'utf8')).id as string;

      const legalConfig = join(dir, 'legal-state.json');
      writeFileSync(join(dir, 'legal.jsonl'), draftToTargetBytes(limit, id.length));
      await invoke(dir, legalConfig, 'legal-output.jsonl', 'legal.jsonl');
      expect(statSync(join(dir, 'legal-output.jsonl')).size).toBe(limit);

      const overConfig = join(dir, 'over-state.json');
      const priorState = { agentId: 42, lastTime: Date.now() - 30_000, sequence: 7 };
      writeFileSync(overConfig, JSON.stringify(priorState));
      writeFileSync(join(dir, 'over.jsonl'), draftToTargetBytes(limit + 1, id.length));
      await expect(invoke(dir, overConfig, 'over-output.jsonl', 'over.jsonl')).rejects.toThrow(/5 MB|减少题数或内容/);
      expect(JSON.parse(readFileSync(overConfig, 'utf8'))).toEqual(priorState);
      expect(existsSync(join(dir, 'over-output.jsonl'))).toBe(false);
      expect(existsSync(`${overConfig}.lock`)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
