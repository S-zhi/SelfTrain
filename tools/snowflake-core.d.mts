export interface SnowflakeState { agentId: number; lastTime: number; sequence: number }
export function validateState(state: unknown, agent: number): SnowflakeState;
export function allocateIds(count: number, state: SnowflakeState, agent: number, clock?: () => number, sleep?: (milliseconds: number) => Promise<unknown>): Promise<{ ids: string[]; state: SnowflakeState }>;
