// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSummary, SessionView, Stats } from '../shared/api';

const mocks = vi.hoisted(() => ({
  api: {
    stats: vi.fn(),
    active: vi.fn(),
    start: vi.fn(),
    answer: vi.fn(),
    next: vi.fn(),
    end: vi.fn(),
    summary: vi.fn(),
    importQuestions: vi.fn(),
    changeInterval: vi.fn(),
    backup: vi.fn(),
    restore: vi.fn(),
  },
}));

vi.mock('../src/api', () => ({
  api: mocks.api,
  ApiRequestError: class ApiRequestError extends Error {
    constructor(
      message: string,
      public readonly details: string[] = [],
      public readonly status: number | null = null,
    ) {
      super(message);
      this.name = 'ApiRequestError';
    }
  },
}));

import { ApiRequestError, api as clientApi } from '../src/api';
import { App } from '../src/App';

const api = vi.mocked(clientApi);

const statsFixture: Stats = {
  questions: { total: 2, new: 2, due: 0, waiting: 0, done: 0, nextDueAt: null },
  first: { correct: 0, total: 0, averageMs: null },
  review: { correct: 0, total: 0, averageMs: null },
  byTopic: [],
  byDay: [],
  history: [],
  sessions: [],
  languages: ['Go'],
  topics: ['语法'],
  intervalHours: 24,
};

function questionView(position = 1, total = 2, stem = `第 ${position} 题`): SessionView {
  const now = Date.now();
  return {
    id: 'session-one',
    targetCount: total,
    total,
    position,
    phase: 'question',
    question: {
      id: `question-${position}`,
      language: 'Go',
      topic: '语法',
      stem,
      options: { A: '甲', B: '乙', C: '丙', D: '丁' },
      durationSeconds: 600,
      startedAt: now,
      deadlineAt: now + 600_000,
      position,
      total,
      phase: 'first',
    },
  };
}

function feedbackView(position = 1, total = 1): SessionView {
  const question = questionView(position, total);
  if (question.phase !== 'question') throw new Error('Expected question view');
  return {
    id: question.id,
    targetCount: question.targetCount,
    total: question.total,
    position,
    phase: 'feedback',
    feedback: {
      question: question.question,
      status: 'correct',
      selectedLabel: 'A',
      correctLabel: 'A',
      explanation: '答案依据。',
      elapsedMs: 800,
    },
  };
}

function timedOutView(id: string, stem: string): SessionView {
  const base = questionView(1, 2, stem);
  if (base.phase !== 'question') throw new Error('Expected question view');
  return {
    id,
    targetCount: 2,
    total: 2,
    position: 1,
    phase: 'feedback',
    feedback: {
      question: base.question,
      status: 'timeout',
      selectedLabel: null,
      correctLabel: 'A',
      explanation: '超时后的解析。',
      elapsedMs: 600_000,
    },
  };
}

const summaryFixture: SessionSummary = {
  id: 'session-one',
  status: 'completed',
  startedAt: 1_760_000_000_000,
  endedAt: 1_760_000_001_000,
  targetCount: 1,
  plannedCount: 1,
  attemptedCount: 1,
  first: { correct: 1, total: 1, averageMs: 800 },
  review: { correct: 0, total: 0, averageMs: null },
  timeoutCount: 0,
  abandonedCount: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  api.stats.mockResolvedValue(statsFixture);
  api.active.mockResolvedValue({ session: null });
  api.start.mockResolvedValue({ session: null, id: null, total: 0, nextDueAt: null });
  api.answer.mockResolvedValue({ session: feedbackView() });
  api.next.mockResolvedValue({ session: questionView(2), summaryId: null });
  api.end.mockResolvedValue({ summary: summaryFixture });
  api.summary.mockResolvedValue(summaryFixture);
  api.importQuestions.mockResolvedValue({ imported: 0, skipped: 0, total: 0 });
  api.changeInterval.mockResolvedValue({ intervalHours: 24 });
  api.backup.mockResolvedValue({});
  api.restore.mockResolvedValue({ restored: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function renderReadyApp() {
  render(<App />);
  await waitFor(() => expect(screen.queryByText('正在连接本地题库…')).not.toBeInTheDocument());
}

describe('应用会话恢复', () => {
  it('会话冲突后同步到另一个页面当前显示的新题', async () => {
    const stale = questionView();
    const current = questionView(2, 2, '另一页面已打开的第二题');
    api.active.mockResolvedValueOnce({ session: stale }).mockResolvedValueOnce({ session: current });
    api.answer.mockRejectedValue(new ApiRequestError('当前题已在另一个页面更新。', [], 409));
    await renderReadyApp();

    fireEvent.click(screen.getByRole('radio', { name: 'A 甲' }));
    fireEvent.click(screen.getByRole('button', { name: '提交答案' }));

    expect(await screen.findByText('另一页面已打开的第二题')).toBeInTheDocument();
    expect(api.active).toHaveBeenCalledTimes(2);
  });

  it('最后一题完成后总结读取失败时移除旧答题页，并允许重试', async () => {
    api.active.mockResolvedValue({ session: feedbackView() });
    api.next.mockResolvedValue({ session: null, summaryId: 'session-one' });
    api.summary.mockRejectedValueOnce(new ApiRequestError('本地服务暂时不可用。'));
    await renderReadyApp();

    fireEvent.click(screen.getByRole('button', { name: '查看本轮总结' }));

    expect(await screen.findByText('结束状态已保存，暂时无法读取总结内容。')).toBeInTheDocument();
    expect(screen.queryByText('答案依据。')).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: '重试读取总结' }).at(-1)!);
    expect(await screen.findByText('这一轮完成了。')).toBeInTheDocument();
    expect(api.next).toHaveBeenCalledOnce();
  });

  it('答案已提交时统计刷新失败不会丢掉反馈，并提供统计重试', async () => {
    api.active.mockResolvedValue({ session: questionView() });
    await renderReadyApp();
    api.stats.mockRejectedValueOnce(new ApiRequestError('统计连接失败。'));

    fireEvent.click(screen.getByRole('radio', { name: 'A 甲' }));
    fireEvent.click(screen.getByRole('button', { name: '提交答案' }));

    expect(await screen.findByText('回答正确')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('答案已保存，统计暂未更新。');
    fireEvent.click(screen.getByRole('button', { name: '重试统计' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByText('回答正确')).toBeInTheDocument();
  });

  it('切回设置页时更新已保存间隔，后台统计同步保留未保存输入', async () => {
    await renderReadyApp();
    fireEvent.click(screen.getByRole('button', { name: '数据与设置' }));
    const interval = screen.getByRole('spinbutton', { name: '间隔小时数' });
    expect(interval).toHaveValue(24);

    api.stats.mockResolvedValue({ ...statsFixture, intervalHours: 72 });
    fireEvent.focus(window);
    await waitFor(() => expect(api.stats).toHaveBeenCalledTimes(2));
    expect(interval).toHaveValue(72);

    fireEvent.change(interval, { target: { value: '48' } });
    api.stats.mockResolvedValue({ ...statsFixture, intervalHours: 96 });
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(api.stats).toHaveBeenCalledTimes(3));
    expect(interval).toHaveValue(48);
  });

  it('过期后服务端已结束轮次时读取总结，不留空白答题页', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const expiring = questionView(1, 1, '即将过期的题目');
    api.active.mockResolvedValueOnce({ session: expiring }).mockResolvedValueOnce({ session: null });
    render(<App />);
    await act(async () => {
      for (let index = 0; index < 6; index += 1) await Promise.resolve();
    });
    expect(screen.getByText('即将过期的题目')).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(600_500);
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });

    expect(screen.getByText('这一轮完成了。')).toBeInTheDocument();
    expect(api.summary).toHaveBeenCalledWith('session-one');
    expect(screen.queryByLabelText('限时答题')).not.toBeInTheDocument();
  });

  it('focus同步请求较旧时不会覆盖用户已进入的下一题', async () => {
    const original = feedbackView(1, 2);
    let resolveActive: (value: { session: SessionView | null }) => void = () => {};
    const delayedActive = new Promise<{ session: SessionView | null }>((resolve) => { resolveActive = resolve; });
    api.active.mockResolvedValueOnce({ session: original }).mockReturnValueOnce(delayedActive);
    api.next.mockResolvedValue({ session: questionView(2, 2, '用户已进入第二题'), summaryId: null });
    await renderReadyApp();

    fireEvent.focus(window);
    await waitFor(() => expect(api.active).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: '下一题' }));
    expect(await screen.findByText('用户已进入第二题')).toBeInTheDocument();

    await act(async () => {
      resolveActive({ session: original });
      await Promise.resolve();
    });
    expect(screen.getByText('用户已进入第二题')).toBeInTheDocument();
  });

  it('切回页面时采用另一标签当前轮次，并在active超时结算后刷新统计', async () => {
    const original = questionView(1, 2, '旧轮题目');
    const activeFromOtherTab = timedOutView('session-two', '新轮超时题目');
    api.active.mockResolvedValueOnce({ session: original }).mockResolvedValueOnce({ session: activeFromOtherTab });
    await renderReadyApp();
    api.stats.mockResolvedValueOnce({ ...statsFixture, questions: { ...statsFixture.questions, due: 1 } });

    fireEvent.focus(window);

    expect(await screen.findByText('时间已到')).toBeInTheDocument();
    expect(screen.getByText('新轮超时题目')).toBeInTheDocument();
    await waitFor(() => expect(api.stats).toHaveBeenCalledTimes(2));
    expect(api.active.mock.invocationCallOrder[1]).toBeLessThan(api.stats.mock.invocationCallOrder[1]);
  });

  it('恢复备份后强制用恢复出的间隔替换旧值', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await renderReadyApp();
    fireEvent.click(screen.getByRole('button', { name: '数据与设置' }));
    const interval = screen.getByRole('spinbutton', { name: '间隔小时数' });
    fireEvent.change(interval, { target: { value: '48' } });
    const backupInput = screen.getByText('选择备份 .json 文件').closest('label')?.querySelector('input');
    expect(backupInput).not.toBeNull();
    const backupFile = new File(['{}'], 'backup.json', { type: 'application/json' });
    Object.defineProperty(backupFile, 'text', { value: async () => '{}' });
    fireEvent.change(backupInput!, { target: { files: [backupFile] } });
    api.stats.mockResolvedValueOnce({ ...statsFixture, intervalHours: 96 });

    fireEvent.click(screen.getByRole('button', { name: '验证并覆盖恢复' }));
    await waitFor(() => expect(api.restore).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: '数据与设置' }));
    expect(screen.getByRole('spinbutton', { name: '间隔小时数' })).toHaveValue(96);
  });
});
