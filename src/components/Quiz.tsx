import { useEffect, useRef, useState } from 'react';
import type { Feedback, SessionView } from '../../shared/api';
import { optionLetters, type OptionLetter } from '../../shared/choice';
import { MarkdownText } from './MarkdownText';

const statusText = {
  correct: '回答正确',
  wrong: '这题还没有掌握',
  timeout: '时间已到',
  abandoned: '已放弃',
} as const;

function timeText(milliseconds: number): string {
  const seconds = Math.ceil(milliseconds / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function Quiz({ view, busy, onAnswer, onNext, onEnd, onExpire }: {
  view: SessionView;
  busy: boolean;
  onAnswer: (answer: OptionLetter) => void;
  onNext: () => void;
  onEnd: () => void;
  onExpire: () => void;
}) {
  const question = view.phase === 'question' ? view.question : view.feedback.question;
  const feedback: Feedback | null = view.phase === 'feedback' ? view.feedback : null;
  const timerKey = `${view.id}:${view.position}:${question.id}:${question.deadlineAt}`;
  const [selected, setSelected] = useState<OptionLetter | null>(null);
  const [clock, setClock] = useState(() => ({ timerKey, remaining: Math.max(0, question.deadlineAt - Date.now()) }));
  const remaining = clock.timerKey === timerKey ? clock.remaining : Math.max(0, question.deadlineAt - Date.now());
  const retryFor = useRef<{ timerKey: string; nextAttemptAt: number } | null>(null);
  const expireRef = useRef(onExpire);
  expireRef.current = onExpire;

  useEffect(() => {
    setSelected(null);
  }, [view.id, view.position, question.id]);

  useEffect(() => {
    if (view.phase !== 'question') return;
    const tick = () => {
      const left = Math.max(0, question.deadlineAt - Date.now());
      setClock((current) => current.timerKey === timerKey && current.remaining === left
        ? current
        : { timerKey, remaining: left });

      if (left === 0 && !busy) {
        if (retryFor.current?.timerKey !== timerKey) {
          retryFor.current = { timerKey, nextAttemptAt: 0 };
        }
        const retry = retryFor.current;
        if (Date.now() >= retry.nextAttemptAt) {
          retry.nextAttemptAt = Date.now() + 2000;
          // Keep retrying a timed-out question until the parent replaces it with feedback.
          // The deadline interval is only 250ms, while this timestamp throttles requests.
          expireRef.current();
        }
      }
    };
    tick();
    const interval = window.setInterval(tick, 250);
    return () => window.clearInterval(interval);
  }, [view.phase, question.deadlineAt, timerKey, busy]);

  const checked = feedback ? feedback.selectedLabel : selected;
  const completed = view.position - (feedback ? 0 : 1);

  return (
    <main className="quiz-shell" aria-label="限时答题">
      <div className="quiz-topline">
        <span className="quiz-kicker">{question.phase === 'first' ? '首次作答' : '间隔复现'} · {question.language} / {question.topic}</span>
        <button type="button" className="text-button" onClick={onEnd} disabled={busy}>结束本轮</button>
      </div>
      <div className="quiz-instruments">
        <div className="sequence" aria-label={`第 ${view.position} 题，共 ${view.total} 题`}>
          <strong>{String(view.position).padStart(2, '0')}</strong><span>/ {String(view.total).padStart(2, '0')}</span>
        </div>
        <div className={`timer ${!feedback && remaining <= 10_000 ? 'timer-warning' : ''}`}>
          <span>本题剩余时间</span>
          <strong aria-label={feedback ? '本题计时结束' : `剩余 ${timeText(remaining)}`}>
            {feedback ? '已停表' : timeText(remaining)}
          </strong>
        </div>
      </div>
      <div className="progress-caption"><span>本轮已完成 {completed} / {view.targetCount}</span><span>{view.total < view.targetCount ? `当前可做 ${view.total} 题` : '目标 30 题'}</span></div>
      <progress className="quiz-progress" value={completed} max={view.targetCount} aria-label="本轮进度" />

      <section className="question-sheet" aria-labelledby="question-title">
        <div className="sheet-header">
          <span className="sheet-mark">Q{String(view.position).padStart(2, '0')}</span>
          <span className="sheet-time">限时 {question.durationSeconds} 秒</span>
        </div>
        <h1 className="visually-hidden" id="question-title">第 {view.position} 题</h1>
        <MarkdownText className="question-stem">{question.stem}</MarkdownText>

        <fieldset className="answer-list" disabled={busy || !!feedback || remaining <= 0}>
          <legend className="visually-hidden">请选择一个答案</legend>
          {optionLetters.map((label) => {
            const correct = feedback?.correctLabel === label;
            const incorrect = feedback?.selectedLabel === label && !correct;
            return (
              <label key={label} className={`answer-choice ${checked === label ? 'is-selected' : ''} ${correct ? 'is-correct' : ''} ${incorrect ? 'is-incorrect' : ''}`}>
                <input
                  type="radio"
                  name={`answer-${view.id}-${view.position}`}
                  value={label}
                  aria-label={`${label} ${question.options[label]}`}
                  checked={checked === label}
                  onChange={() => setSelected(label)}
                />
                <span className="answer-letter" aria-hidden="true">{label}</span>
                <span className="answer-content">{question.options[label]}</span>
                {feedback && correct && <span className="choice-result">正确答案</span>}
              </label>
            );
          })}
        </fieldset>

        {feedback && (
          <div className={`feedback-panel feedback-${feedback.status}`} role="status" aria-live="polite">
            <div className="feedback-heading">
              <span className="feedback-symbol" aria-hidden="true">{feedback.status === 'correct' ? '✓' : '!'}</span>
              <div>
                <strong>{statusText[feedback.status]}</strong>
                <p>正确选项是 {feedback.correctLabel} · 用时 {(feedback.elapsedMs / 1000).toFixed(1)} 秒</p>
              </div>
            </div>
            <div className="feedback-explanation"><span>解题依据</span><MarkdownText>{feedback.explanation}</MarkdownText></div>
            {feedback.status !== 'correct' && <p className="feedback-next">这道题会在间隔到期后再次出现，直到你答对。</p>}
          </div>
        )}

        <div className="question-actions">
          <span className="action-hint">{feedback ? '先看解析，再进入下一题' : '选好答案后提交；提交前可更改选择'}</span>
          {feedback ? (
            <button type="button" className="primary-button" onClick={onNext} disabled={busy}>
              {view.position === view.total ? '查看本轮总结' : '下一题'} <span aria-hidden="true">↗</span>
            </button>
          ) : (
            <button type="button" className="primary-button" onClick={() => selected && onAnswer(selected)} disabled={!selected || busy || remaining <= 0}>
              提交答案 <span aria-hidden="true">↗</span>
            </button>
          )}
        </div>
      </section>
      <p className="quiz-footnote">计时以本地服务记录的截止时间为准；切换页面不会暂停。</p>
    </main>
  );
}
