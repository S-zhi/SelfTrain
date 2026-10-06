const EPOCH = Date.UTC(2024, 0, 1);

export function validateState(state, agent) {
  if (!state || typeof state !== 'object' || Array.isArray(state)
    || !Object.hasOwn(state, 'lastTime') || !Object.hasOwn(state, 'sequence')
    || typeof state.lastTime !== 'number' || typeof state.sequence !== 'number') throw new Error('ID 状态文件损坏或字段超出范围；为避免重复分配，已停止。');
  const { lastTime, sequence } = state;
  if (state.agentId !== agent || !Number.isInteger(state.agentId) || state.agentId < 0 || state.agentId > 1023
    || !Number.isSafeInteger(lastTime) || lastTime < -1
    || !Number.isInteger(sequence) || sequence < -1 || sequence > 4095
    || (lastTime === -1) !== (sequence === -1)) throw new Error('ID 状态文件损坏或字段超出范围；为避免重复分配，已停止。');
  return { agentId: agent, lastTime, sequence };
}

export async function allocateIds(count, state, agent, clock = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  const next = { ...state };
  const ids = [];
  for (let i = 0; i < count; i++) {
    let time = clock();
    if (time < next.lastTime) throw new Error('系统时钟回拨，停止分配 ID。');
    if (time === next.lastTime) next.sequence += 1;
    else { next.lastTime = time; next.sequence = 0; }
    while (next.sequence > 4095) {
      await sleep(1);
      time = clock();
      if (time < next.lastTime) throw new Error('系统时钟回拨，停止分配 ID。');
      if (time > next.lastTime) { next.lastTime = time; next.sequence = 0; }
    }
    if (next.lastTime - EPOCH < 0 || next.lastTime - EPOCH >= 2 ** 41) throw new Error('时间戳超出雪花 ID 可表示范围。');
    ids.push(((BigInt(next.lastTime - EPOCH) << 22n) | (BigInt(agent) << 12n) | BigInt(next.sequence)).toString());
  }
  return { ids, state: next };
}
