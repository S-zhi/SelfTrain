import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allocateIds, validateState } from '../tools/snowflake-core.mjs';

const run = promisify(execFile);
const script = resolve('tools/assign-snowflake-ids.mjs');
const draft = JSON.stringify({ id: 'draft-1', language: 'Go', topic: 't', stem: 's', options: { A: 'a', B: 'b', C: 'c', D: 'd' }, answer: 'A', explanation: 'e', duration_seconds: 30 }) + '\n';
const invoke = (dir: string, config: string, output: string) => run(process.execPath, [script, '--agent-id', '42', '--input', join(dir, 'draft.jsonl'), '--output', join(dir, output), '--config', config]);

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
});
