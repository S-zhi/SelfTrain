import { useState } from 'react';
import type { SessionSummary, Stats } from '../../shared/api';
import { dateTime, duration, percentage, statusLabel } from '../format';

function Figure({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="figure"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

export function Dashboard({ stats, busy, onStart, onImport }: {
  stats: Stats;
  busy: boolean;
  onStart: (language: string | null, topic: string | null) => void;
  onImport: () => void;
}) {
  const [language, setLanguage] = useState('');
  const [topic, setTopic] = useState('');
  const topics = [...new Set(stats.byTopic.filter((row) => !language || row.language === language).map((row) => row.topic))];
  const available = stats.questions.due + stats.questions.new;

  return <main className="main-content">
    <section className="intro-block">
      <div className="intro-copy">
        <span className="section-label">你的学习工作台</span>
        <h1>留下一次真实的作答。</h1>
        <p>先答到期的题，再接着做新题。每题单独限时；首次成绩与复习表现分别记录。</p>
      </div>
      <div className="today-mark" aria-label={`当前可做 ${available} 题`}>
        <span>当前可做</span><strong>{available}</strong><span>道题</span>
      </div>
    </section>

    <div className="figures" aria-label="学习概览">
      <Figure label="首次正确率" value={percentage(stats.first)} detail={`${stats.first.correct} / ${stats.first.total} 道首次作答`} />
      <Figure label="到期复现" value={String(stats.questions.due)} detail={`${stats.questions.waiting} 道尚未到期`} />
      <Figure label="已完成复现" value={String(stats.questions.done)} detail={`题库共 ${stats.questions.total} 道`} />
      <Figure label="平均作答用时" value={duration(stats.first.averageMs)} detail="首次作答，含超时和放弃" />
    </div>

    <section className="launch-panel" aria-labelledby="launch-title">
      <div className="launch-heading">
        <div><span className="section-label">开始一轮</span><h2 id="launch-title">30 道题，逐题完成</h2></div>
        <span className="launch-note">{available ? '到期题优先 · 不提前复现' : stats.questions.nextDueAt ? `下一道复现：${dateTime(stats.questions.nextDueAt)}` : '暂无可做题目'}</span>
      </div>
      <div className="launch-controls">
        <label>语言
          <select value={language} onChange={(event) => { setLanguage(event.target.value); setTopic(''); }}>
            <option value="">全部语言</option>
            {stats.languages.map((name) => <option key={name}>{name}</option>)}
          </select>
        </label>
        <label>主题
          <select value={topic} onChange={(event) => setTopic(event.target.value)}>
            <option value="">全部主题</option>
            {topics.map((name) => <option key={name}>{name}</option>)}
          </select>
        </label>
        <button type="button" className="primary-button" disabled={busy || !available} onClick={() => onStart(language || null, topic || null)}>
          开始限时作答 <span aria-hidden="true">↗</span>
        </button>
      </div>
      {!stats.questions.total && <div className="launch-empty">题库还是空的。<button type="button" className="inline-link" onClick={onImport}>先导入 JSONL 或使用 Go 示例题</button></div>}
      {!!stats.questions.total && !available && <p className="launch-empty">已做题目尚未到复现时间，或已全部完成。导入新题后可继续。</p>}
    </section>

    <section className="dashboard-bottom">
      <div className="note-panel"><span className="section-label">复现规则</span><h2>答对以后，再确认一次。</h2><p>首次答对的题会间隔出现一次；任何答错、超时或放弃的题都会继续间隔复现，直到后续答对。当前间隔为 {stats.intervalHours} 小时。</p></div>
      <div className="recent-panel"><span className="section-label">最近一轮</span>{stats.sessions.length ? <><h2>{stats.sessions[0].attemptedCount} 道已记录</h2><p>{dateTime(stats.sessions[0].endedAt)} · 首次答对 {stats.sessions[0].first.correct} / {stats.sessions[0].first.total}，复现答对 {stats.sessions[0].review.correct} / {stats.sessions[0].review.total}。</p></> : <><h2>从第一道题开始</h2><p>完成作答后，这里会保留你真实的进展。</p></>}</div>
    </section>
  </main>;
}

export function History({ stats, onOpenSummary }: { stats: Stats; onOpenSummary: (id: string) => void }) {
  return <main className="main-content history-page">
    <header className="page-heading"><span className="section-label">学习记录</span><h1>看见哪些知识点正在变稳。</h1><p>首次作答与到期复现各有分母，不把重做正确混进首次成绩。</p></header>
    <div className="figures figures-three">
      <Figure label="首次正确率" value={percentage(stats.first)} detail={`${stats.first.correct} / ${stats.first.total} 次`} />
      <Figure label="复现正确率" value={percentage(stats.review)} detail={`${stats.review.correct} / ${stats.review.total} 次`} />
      <Figure label="首次平均用时" value={duration(stats.first.averageMs)} detail="已记录的首次尝试" />
    </div>
    <section className="data-section"><div className="data-title"><h2>按主题</h2><p>先看首次成绩，再看复现情况</p></div>
      {stats.byTopic.length ? <div className="table-scroll"><table><thead><tr><th scope="col">语言 / 主题</th><th scope="col">首次答对</th><th scope="col">复现答对</th></tr></thead><tbody>
        {stats.byTopic.map((row) => <tr key={`${row.language}-${row.topic}`}><th scope="row"><span className="table-sub">{row.language}</span>{row.topic}</th><td>{row.first.total ? `${row.first.correct} / ${row.first.total} (${percentage(row.first)})` : '尚未作答'}</td><td>{row.review.total ? `${row.review.correct} / ${row.review.total} (${percentage(row.review)})` : '尚未复现'}</td></tr>)}
      </tbody></table></div> : <p className="empty-note">导入题目后，这里会按语言和主题分组。</p>}
    </section>
    <section className="data-section"><div className="data-title"><h2>按天</h2><p>按本机日期记录最近 30 个有作答的日子</p></div>
      {stats.byDay.length ? <div className="table-scroll"><table><thead><tr><th scope="col">日期</th><th scope="col">首次答对</th><th scope="col">复现答对</th></tr></thead><tbody>
        {stats.byDay.map((row) => <tr key={row.day}><th scope="row">{row.day}</th><td>{row.first.correct} / {row.first.total}</td><td>{row.review.correct} / {row.review.total}</td></tr>)}
      </tbody></table></div> : <p className="empty-note">完成一道题后，才会出现按天记录。</p>}
    </section>
    <section className="data-section"><div className="data-title"><h2>最近答题</h2><p>最多展示最近 100 次尝试；备份包含完整历史</p></div>
      {stats.history.length ? <ol className="attempt-list">{stats.history.map((attempt) => <li key={attempt.id}>
        <span className={`attempt-status status-${attempt.status}`}>{statusLabel(attempt.status)}</span>
        <div className="attempt-detail"><strong>{attempt.stem.replace(/```[\s\S]*?```/g, '【代码】').split('\n')[0].slice(0, 90)}</strong><span>{attempt.language} / {attempt.topic} · {attempt.phase === 'first' ? '首次' : '复现'} · 用时 {duration(attempt.elapsedMs)}</span></div>
        <time dateTime={new Date(attempt.completedAt).toISOString()}>{dateTime(attempt.completedAt)}</time>
      </li>)}</ol> : <p className="empty-note">还没有作答记录。</p>}
    </section>
    {!!stats.sessions.length && <section className="data-section"><div className="data-title"><h2>本轮总结</h2><p>最近 12 轮</p></div><div className="session-list">{stats.sessions.map((session) => <button type="button" key={session.id} onClick={() => onOpenSummary(session.id)}><span>{dateTime(session.endedAt)}</span><strong>{session.attemptedCount} 道已记录</strong><span>{session.status === 'ended' ? '提前结束' : '完成本轮'} ↗</span></button>)}</div></section>}
  </main>;
}

export function Summary({ summary, onHome, onHistory }: {
  summary: SessionSummary;
  onHome: () => void;
  onHistory: () => void;
}) {
  return <main className="main-content summary-page">
    <header className="page-heading"><span className="section-label">本轮总结 · {dateTime(summary.endedAt)}</span><h1>{summary.status === 'ended' ? '这一轮已提前结束。' : '这一轮完成了。'}</h1><p>记录了 {summary.attemptedCount} 次尝试，原计划最多 {summary.targetCount} 道；本轮可做题为 {summary.plannedCount} 道。</p></header>
    <div className="summary-split"><div><span>首次作答</span><strong>{summary.first.correct}<small> / {summary.first.total}</small></strong><p>正确率 {percentage(summary.first)} · 平均 {duration(summary.first.averageMs)}</p></div><div><span>间隔复现</span><strong>{summary.review.correct}<small> / {summary.review.total}</small></strong><p>正确率 {percentage(summary.review)} · 平均 {duration(summary.review.averageMs)}</p></div></div>
    <div className="summary-detail"><span>超时 {summary.timeoutCount} 道</span><span>放弃 {summary.abandonedCount} 道</span><span>未打开的题目不计入成绩</span></div>
    <div className="summary-actions"><button type="button" className="primary-button" onClick={onHome}>返回工作台 <span aria-hidden="true">↗</span></button><button type="button" className="secondary-button" onClick={onHistory}>查看学习记录</button></div>
  </main>;
}
