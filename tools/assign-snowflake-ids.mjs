#!/usr/bin/env node
import { open, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { allocateIds, validateState } from './snowflake-core.mjs';
const args = Object.fromEntries(process.argv.slice(2).reduce((out, arg, i, all) => {
  if (arg.startsWith('--')) out.push([arg.slice(2), all[i + 1]]);
  return out;
}, []));
if (!args.input || !args.output || !args['agent-id']) {
  console.error('用法：node tools/assign-snowflake-ids.mjs --agent-id 1 --input draft.jsonl --output questions.jsonl [--config .selftrain-id-state.json]'); process.exit(2);
}
const agent = Number(args['agent-id']);
if (!Number.isInteger(agent) || agent < 0 || agent > 1023) throw new Error('Agent ID 必须是 0–1023 的整数。');
const config = resolve(args.config ?? '.selftrain-id-state.json');
const lock = `${config}.lock`;
let handle;
const until = Date.now() + 30000;
while (!handle) {
  try { handle = await open(lock, 'wx', 0o600); }
  catch (error) { if (error.code !== 'EEXIST' || Date.now() >= until) throw new Error('无法取得 ID 状态锁；若没有其他生成进程，请检查并清理残留锁文件。'); await delay(20 + Math.random() * 40); }
}
try {
  const source = await readFile(resolve(args.input), 'utf8');
  const records = [];
  for (const [index, line] of source.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let value;
    try { value = JSON.parse(line); } catch { throw new Error(`输入第 ${index + 1} 行不是有效 JSON。`); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`输入第 ${index + 1} 行必须是 JSON 对象。`);
    records.push(value);
  }
  if (!records.length || records.length > 5000) throw new Error('输入必须包含 1–5000 道非空题目。');
  let state = { agentId: agent, lastTime: -1, sequence: -1 };
  try { state = JSON.parse(await readFile(config, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error(`无法读取 ID 状态：${error.message}`); }
  if (state.agentId !== agent) throw new Error(`状态文件已绑定 Agent ID ${state.agentId}，不能改为 ${agent}；每个 Agent ID 使用独立状态文件。`);
  state = validateState(state, agent);
  const lastTime = state.lastTime;
  const now = Date.now();
  if (lastTime >= 0 && now < lastTime) throw new Error(`系统时钟回拨：当前 ${now} 早于已分配时间 ${lastTime}。请校准时钟后重试。`);
  const allocation = await allocateIds(records.length, state, agent);
  const ids = allocation.ids;
  const temp = `${config}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(allocation.state, null, 2), { mode: 0o600 });
  await rename(temp, config);
  const output = records.map((record, index) => JSON.stringify({ ...record, id: ids[index] })).join('\n') + '\n';
  await writeFile(resolve(args.output), output, { flag: 'wx' });
} finally { await handle.close(); const { unlink } = await import('node:fs/promises'); await unlink(lock).catch(() => {}); }
