import type { Score } from '../shared/api';

export function percentage(score: Score): string {
  return score.total ? `${Math.round(score.correct / score.total * 100)}%` : '—';
}

export function duration(milliseconds: number | null): string {
  return milliseconds === null ? '—' : `${(milliseconds / 1000).toFixed(1)} 秒`;
}

export function dateTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(timestamp);
}

export function statusLabel(status: string): string {
  return ({ correct: '答对', wrong: '答错', timeout: '超时', abandoned: '放弃' } as Record<string, string>)[status] ?? status;
}
