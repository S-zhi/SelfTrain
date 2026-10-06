import type { ImportResult, SessionSummary, SessionView, Stats } from '../shared/api';

export class ApiRequestError extends Error {
  constructor(
    message: string,
    public readonly details: string[] = [],
    public readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

async function request<T>(path: string, method: 'GET' | 'POST' | 'PUT' = 'GET', body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers: method === 'GET' ? undefined : { 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      cache: 'no-store',
    });
  } catch {
    throw new ApiRequestError('无法连接到本地服务，请确认应用仍在运行。');
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string; details?: string[] };
    throw new ApiRequestError(payload.error ?? '操作未完成，请重试。', payload.details ?? [], response.status);
  }
  return response.json() as Promise<T>;
}

export const api = {
  stats: () => request<Stats>('/stats'),
  importQuestions: (jsonl: string) => request<ImportResult>('/questions/import', 'POST', { jsonl }),
  changeInterval: (intervalHours: number) => request<{ intervalHours: number }>('/settings', 'PUT', { intervalHours }),
  active: () => request<{ session: SessionView | null }>('/sessions/active/view', 'POST'),
  start: (language: string | null, topic: string | null) =>
    request<{ id: string | null; total: number; nextDueAt: number | null; session: SessionView | null }>(
      '/sessions', 'POST', { language, topic },
    ),
  answer: (id: string, position: number, selectedLabel: string) =>
    request<{ session: SessionView }>(`/sessions/${encodeURIComponent(id)}/answer`, 'POST', { selectedLabel, position }),
  next: (id: string, position: number) =>
    request<{ session: SessionView | null; summaryId: string | null }>(`/sessions/${encodeURIComponent(id)}/next`, 'POST', { position }),
  end: (id: string, position: number) =>
    request<{ summary: SessionSummary }>(`/sessions/${encodeURIComponent(id)}/end`, 'POST', { position }),
  summary: (id: string) => request<SessionSummary>(`/sessions/${encodeURIComponent(id)}/summary`),
  backup: () => request<unknown>('/backup'),
  restore: (backup: unknown) => request<{ restored: boolean }>('/backup/restore', 'POST', backup),
};
