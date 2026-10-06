// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionView } from '../shared/api';
import { MarkdownText } from '../src/components/MarkdownText';
import { Quiz } from '../src/components/Quiz';

const start = 1_760_000_000_000;
const question = {
  id: 'go-test', language: 'Go', topic: '变量', stem: '请选择正确的选项。',
  options: { A: '甲', B: '乙', C: '丙', D: '丁' }, durationSeconds: 2,
  startedAt: start, deadlineAt: start + 2000, position: 1, total: 30, phase: 'first' as const,
};
const view: SessionView = { id: 'session-one', phase: 'question', position: 1, total: 30, targetCount: 30, question };

function callbacks() {
  return { onAnswer: vi.fn(), onNext: vi.fn(), onEnd: vi.fn(), onExpire: vi.fn() };
}

describe('限时答题界面', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(start); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('有四个可访问的选项，提交前可以改变选择且不暴露答案', () => {
    const actions = callbacks();
    render(<Quiz view={view} busy={false} {...actions} />);
    expect(screen.getAllByRole('radio')).toHaveLength(4);
    expect(screen.queryByText('解题依据')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '提交答案' })).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: 'A 甲' }));
    fireEvent.click(screen.getByRole('radio', { name: 'B 乙' }));
    fireEvent.click(screen.getByRole('button', { name: '提交答案' }));
    expect(actions.onAnswer).toHaveBeenCalledWith('B');
  });

  it('提交后的正确反馈显示解析并由下一题按钮继续', () => {
    const actions = callbacks();
    const answered: SessionView = {
      ...view, phase: 'feedback', feedback: {
        question, status: 'correct', selectedLabel: 'B', correctLabel: 'B',
        explanation: '乙是标准答案。', elapsedMs: 500,
      },
    };
    render(<Quiz view={answered} busy={false} {...actions} />);
    expect(screen.getByText('回答正确')).toBeInTheDocument();
    expect(screen.getByText('乙是标准答案。')).toBeInTheDocument();
    screen.getAllByRole('radio').forEach((radio) => expect(radio).toBeDisabled());
    act(() => { vi.advanceTimersByTime(5000); });
    expect(actions.onExpire).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '下一题' }));
    expect(actions.onNext).toHaveBeenCalledOnce();
  });

  it('到期后同步；收到超时反馈后停止重试且不能再提交', () => {
    const actions = callbacks();
    const rendered = render(<Quiz view={view} busy={false} {...actions} />);
    fireEvent.click(screen.getByRole('radio', { name: 'A 甲' }));
    act(() => { vi.advanceTimersByTime(2000); });
    expect(actions.onExpire).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: '提交答案' })).toBeDisabled();

    const expired: SessionView = {
      ...view, phase: 'feedback', feedback: {
        question, status: 'timeout', selectedLabel: null, correctLabel: 'B',
        explanation: '乙是标准答案。', elapsedMs: 2000,
      },
    };
    rendered.rerender(<Quiz view={expired} busy={false} {...actions} />);
    act(() => { vi.advanceTimersByTime(3000); });
    expect(actions.onExpire).toHaveBeenCalledOnce();
  });

  it('题目仍处于作答态时，每隔约两秒重试一次超时同步', () => {
    const actions = callbacks();
    render(<Quiz view={view} busy={false} {...actions} />);
    act(() => { vi.advanceTimersByTime(2000); });
    expect(actions.onExpire).toHaveBeenCalledOnce();

    act(() => { vi.advanceTimersByTime(1999); });
    expect(actions.onExpire).toHaveBeenCalledOnce();
    act(() => { vi.advanceTimersByTime(1); });
    expect(actions.onExpire).toHaveBeenCalledTimes(2);
  });

  it('请求忙碌跨过截止时间时跳过同步，忙碌结束后立即补同步', () => {
    const actions = callbacks();
    const rendered = render(<Quiz view={view} busy {...actions} />);
    act(() => { vi.advanceTimersByTime(2500); });
    expect(actions.onExpire).not.toHaveBeenCalled();

    rendered.rerender(<Quiz view={view} busy={false} {...actions} />);
    expect(actions.onExpire).toHaveBeenCalledOnce();
  });

  it('同一道题重新渲染不会延长期限，下一道题会清除旧选择', () => {
    const actions = callbacks();
    const rendered = render(<Quiz view={view} busy={false} {...actions} />);
    fireEvent.click(screen.getByRole('radio', { name: 'A 甲' }));
    act(() => { vi.advanceTimersByTime(1000); });
    rendered.rerender(<Quiz view={{ ...view }} busy={false} {...actions} />);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(actions.onExpire).toHaveBeenCalledOnce();
    const second: SessionView = {
      ...view, position: 2, question: { ...question, id: 'next', position: 2, startedAt: start + 2000, deadlineAt: start + 10_000 },
    };
    rendered.rerender(<Quiz view={second} busy={false} {...actions} />);
    expect(screen.getByRole('button', { name: '提交答案' })).toBeDisabled();
    expect(screen.getAllByRole('radio').some((radio) => (radio as HTMLInputElement).checked)).toBe(false);
    expect(screen.getByLabelText('剩余 00:08')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'A 甲' }));
    expect(screen.getByRole('button', { name: '提交答案' })).toBeEnabled();
    act(() => { vi.advanceTimersByTime(2000); });
    expect(actions.onExpire).toHaveBeenCalledOnce();
  });

  it('卸载后清理重试计时器', () => {
    const actions = callbacks();
    const rendered = render(<Quiz view={view} busy={false} {...actions} />);
    act(() => { vi.advanceTimersByTime(2000); });
    expect(actions.onExpire).toHaveBeenCalledOnce();
    rendered.unmount();
    act(() => { vi.advanceTimersByTime(5000); });
    expect(actions.onExpire).toHaveBeenCalledOnce();
  });

  it('超时反馈不把未提交的本地选择显示成已提交答案', () => {
    const actions = callbacks();
    const rendered = render(<Quiz view={view} busy={false} {...actions} />);
    fireEvent.click(screen.getByRole('radio', { name: 'A 甲' }));
    const expired: SessionView = {
      ...view, phase: 'feedback', feedback: {
        question, status: 'timeout', selectedLabel: null, correctLabel: 'B',
        explanation: '乙是标准答案。', elapsedMs: 2000,
      },
    };
    rendered.rerender(<Quiz view={expired} busy={false} {...actions} />);
    expect(screen.getAllByRole('radio').some((radio) => (radio as HTMLInputElement).checked)).toBe(false);
    expect(screen.getByText('时间已到')).toBeInTheDocument();
  });

  it('Markdown 不渲染 HTML、远程图片或可点击的外部链接', () => {
    const rendered = render(<MarkdownText>{'<script>alert(1)</script>\n\n![remote](https://example.com/image.png)\n\n[外部](https://example.com)'}</MarkdownText>);
    expect(rendered.container.querySelector('script')).toBeNull();
    expect(rendered.container.querySelector('img')).toBeNull();
    expect(rendered.container.querySelector('a')).toBeNull();
    expect(screen.getByText('外部')).toBeInTheDocument();
  });
});
