import { useEffect, useRef, useState } from 'react';
import goExamples from '../examples/go-syntax.jsonl?raw';
import type { ImportResult, SessionSummary, SessionView, Stats } from '../shared/api';
import type { OptionLetter } from '../shared/question';
import { ApiRequestError, api } from './api';
import { Quiz } from './components/Quiz';
import { Dashboard, History, Summary } from './components/Stats';
import { dateTime } from './format';

type Page = 'home' | 'import' | 'history' | 'settings' | 'session' | 'summary';
type RecoveryAction = 'session' | 'stats' | 'summary';
type AppError = { message: string; details: string[]; recovery?: RecoveryAction };

export function App() {
  const [page, setPage] = useState<Page>('home');
  const [stats, setStats] = useState<Stats | null>(null);
  const [view, setView] = useState<SessionView | null>(null);
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AppError | null>(null);
  const [notice, setNotice] = useState('');
  const [importFiles, setImportFiles] = useState<File[]>([]);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [intervalValue, setIntervalValue] = useState('24');
  const fileInput = useRef<HTMLInputElement>(null);
  const restoreInput = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const viewRef = useRef<SessionView | null>(null);
  const generationRef = useRef(0);
  const passiveSyncRef = useRef<Promise<void> | null>(null);
  const [summaryRecoveryId, setSummaryRecoveryId] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const persistedIntervalRef = useRef<string | null>(null);
  const intervalDirtyRef = useRef(false);

  viewRef.current = view;

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [page, view?.id, view?.position]);

  async function refreshStats(options: { syncIntervalValue?: boolean; forceIntervalValue?: boolean } = {}) {
    const updated = await api.stats();
    setStats(updated);
    if (options.syncIntervalValue && (options.forceIntervalValue || !intervalDirtyRef.current)) {
      const persisted = String(updated.intervalHours);
      setIntervalValue(persisted);
      persistedIntervalRef.current = persisted;
      intervalDirtyRef.current = false;
    }
  }

  useEffect(() => {
    let current = true;
    (async () => {
      try {
        const active = await api.active();
        const updated = await api.stats();
        if (!current) return;
        setView(active.session);
        if (active.session) setPage('session');
        setStats(updated);
        setIntervalValue(String(updated.intervalHours));
        persistedIntervalRef.current = String(updated.intervalHours);
        intervalDirtyRef.current = false;
      } catch (cause) {
        if (current) showError(cause);
      } finally {
        if (current) setLoading(false);
      }
    })();
    return () => { current = false; };
  }, []);

  function showError(cause: unknown, recovery?: RecoveryAction, message?: string) {
    setError(cause instanceof ApiRequestError
      ? { message: message ?? cause.message, details: cause.details, recovery }
      : { message: message ?? '操作未完成，请重试。', details: [], recovery });
  }

  async function run(work: () => Promise<void>, options: {
    sessionAction?: boolean;
    sessionId?: string;
    retryOnError?: RecoveryAction;
  } = {}) {
    if (busyRef.current) return;
    busyRef.current = true;
    generationRef.current += 1;
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      await work();
    } catch (cause) {
      if (options.sessionAction && cause instanceof ApiRequestError && cause.status === 409) {
        try {
          await synchronizeSession(options.sessionId);
        } catch (syncCause) {
          showError(syncCause, 'session');
        }
      } else {
        showError(cause, options.retryOnError);
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function navigate(destination: Page) {
    if (view || busyRef.current) return;
    generationRef.current += 1;
    if (destination === 'settings' && !intervalDirtyRef.current && stats) {
      const persisted = String(stats.intervalHours);
      setIntervalValue(persisted);
      persistedIntervalRef.current = persisted;
    }
    setError(null);
    setNotice('');
    setPage(destination);
  }

  async function refreshStatsAfterCommit(message: string, options: { forceIntervalValue?: boolean } = {}) {
    try {
      await refreshStats({ syncIntervalValue: true, forceIntervalValue: options.forceIntervalValue });
    } catch (cause) {
      showError(cause, 'stats', message);
    }
  }

  async function showSessionSummary(id: string, isCurrent: () => boolean = () => true) {
    setSummaryRecoveryId(id);
    setSummary(null);
    setView(null);
    setPage('summary');
    setSummaryLoading(true);
    try {
      const finished = await api.summary(id);
      if (!isCurrent()) return;
      setSummary(finished);
      setSummaryRecoveryId(null);
    } finally {
      if (isCurrent()) setSummaryLoading(false);
    }
  }

  async function synchronizeSession(staleSessionId?: string) {
    const active = await api.active();
    if (active.session) {
      setView(active.session);
      setSummary(null);
      setSummaryRecoveryId(null);
      setPage('session');
      setNotice('已同步到本轮最新进度。');
    } else if (staleSessionId) {
      try {
        await showSessionSummary(staleSessionId);
        setNotice('本轮已在其他页面结束，已读取本轮总结。');
      } catch (cause) {
        showError(cause, 'summary');
        await refreshStatsAfterCommit('本轮已结束，统计暂未更新。');
        return;
      }
    } else {
      setView(null);
      setNotice('当前没有进行中的答题。');
    }
    await refreshStatsAfterCommit('进度已同步，统计暂未更新。');
  }

  async function retryRecovery(action: RecoveryAction) {
    if (action === 'session') {
      await run(() => synchronizeSession(viewRef.current?.id), { retryOnError: 'session' });
    } else if (action === 'stats') {
      await run(async () => {
        await refreshStats({ syncIntervalValue: true });
        setNotice('统计已更新。');
      }, { retryOnError: 'stats' });
    } else if (summaryRecoveryId) {
      await run(async () => {
        await showSessionSummary(summaryRecoveryId);
      }, { retryOnError: 'summary' });
    }
  }

  useEffect(() => {
    let current = true;
    const syncWhenVisible = () => {
      if (!current || document.visibilityState === 'hidden' || busyRef.current) return;
      if (passiveSyncRef.current) return;
      const displayedView = viewRef.current;
      const generation = generationRef.current;
      const displayedId = displayedView?.id;
      const isCurrent = () => current && !busyRef.current && generationRef.current === generation;
      const sync = async () => {
        if (displayedId) {
          try {
            const active = await api.active();
            if (!isCurrent() || viewRef.current?.id !== displayedId) return;
            if (active.session) {
              setView(active.session);
              setSummary(null);
              setSummaryRecoveryId(null);
              setPage('session');
            } else if (!active.session) {
              await showSessionSummary(displayedId, isCurrent);
            }
          } catch {
            // Keep the visible question until an explicit sync can recover it.
          }
        }
        try {
          const updated = await api.stats();
          if (!isCurrent()) return;
          setStats(updated);
          if (!intervalDirtyRef.current) {
            const persisted = String(updated.intervalHours);
            setIntervalValue(persisted);
            persistedIntervalRef.current = persisted;
          }
        } catch {
          // Passive refreshes should not interrupt the current screen; explicit actions expose recovery.
        }
      };
      const pending = sync();
      passiveSyncRef.current = pending;
      void pending.finally(() => {
        if (passiveSyncRef.current === pending) passiveSyncRef.current = null;
      });
    };
    window.addEventListener('focus', syncWhenVisible);
    document.addEventListener('visibilitychange', syncWhenVisible);
    return () => {
      current = false;
      window.removeEventListener('focus', syncWhenVisible);
      document.removeEventListener('visibilitychange', syncWhenVisible);
    };
  }, []);

  function start(language: string | null, topic: string | null) {
    void run(async () => {
      const result = await api.start(language, topic);
      if (!result.session) {
        setNotice(result.nextDueAt
          ? `这个筛选范围暂时没有可做的题。下一道复现题将于 ${dateTime(result.nextDueAt)} 到期。`
          : '这个筛选范围暂时没有可做的题，请调整筛选或导入新题。');
        return;
      }
      setView(result.session);
      setPage('session');
      await refreshStatsAfterCommit('本轮已开始，统计暂未更新。');
    }, { sessionAction: true, retryOnError: 'session' });
  }

  function answer(selected: OptionLetter) {
    if (!view) return;
    void run(async () => {
      const result = await api.answer(view.id, view.position, selected);
      setView(result.session);
      await refreshStatsAfterCommit('答案已保存，统计暂未更新。');
    }, { sessionAction: true, sessionId: view.id, retryOnError: 'session' });
  }

  function expire() {
    if (!view || busy) return;
    void run(async () => {
      const result = await api.active();
      if (result.session) setView(result.session);
      else {
        try {
          await showSessionSummary(view.id);
        } catch (cause) {
          showError(cause, 'summary');
          return;
        }
      }
      await refreshStatsAfterCommit('进度已同步，统计暂未更新。');
    }, { sessionAction: true, sessionId: view.id, retryOnError: 'session' });
  }

  function next() {
    if (!view) return;
    void run(async () => {
      const result = await api.next(view.id, view.position);
      if (result.summaryId) {
        try {
          await showSessionSummary(result.summaryId);
        } catch (cause) {
          showError(cause, 'summary');
          return;
        }
      } else {
        setView(result.session);
      }
      await refreshStatsAfterCommit('进度已保存，统计暂未更新。');
    }, { sessionAction: true, sessionId: view.id, retryOnError: 'session' });
  }

  function end() {
    if (!view) return;
    const note = view.phase === 'question'
      ? '确定结束本轮吗？当前已显示、尚未提交的题会记为「放弃」，其余未打开的题不计分。'
      : '确定结束本轮吗？已作答的题会保留，其余未打开的题不计分。';
    if (!window.confirm(note)) return;
    void run(async () => {
      const result = await api.end(view.id, view.position);
      setSummary(result.summary);
      setView(null);
      setSummaryRecoveryId(null);
      setPage('summary');
      await refreshStatsAfterCommit('本轮已结束，统计暂未更新。');
    }, { sessionAction: true, sessionId: view.id, retryOnError: 'session' });
  }

  async function importText(text: string) {
    const result = await api.importQuestions(text);
    setImportResult(result);
    await refreshStatsAfterCommit('题目已导入，统计暂未更新。');
    setNotice(`导入完成：新增 ${result.imported} 道，跳过相同题 ${result.skipped} 道。`);
  }

  function importSelected() {
    if (!importFiles.length) return;
    void run(async () => {
      const totalBytes = importFiles.reduce((total, file) => total + file.size, 0);
      if (totalBytes > 5 * 1024 * 1024) throw new ApiRequestError('所选 JSONL 文件合计不能超过 5 MB。');
      const files = await Promise.all(importFiles.map(async (file) => ({ name: file.name, jsonl: await file.text() })));
      const result = await api.importQuestions(files);
      setImportResult(result);
      await refreshStatsAfterCommit('题目已导入，统计暂未更新。');
      setNotice(`导入完成：新增 ${result.imported} 道，跳过相同题 ${result.skipped} 道。`);
      setImportFiles([]);
      if (fileInput.current) fileInput.current.value = '';
    });
  }

  function importExample() {
    void run(async () => { await importText(goExamples); });
  }

  function saveInterval() {
    void run(async () => {
      const value = Number(intervalValue);
      if (!Number.isInteger(value) || value < 1 || value > 720) {
        throw new ApiRequestError('复现间隔必须是 1–720 小时之间的整数。');
      }
      await api.changeInterval(value);
      setIntervalValue(String(value));
      persistedIntervalRef.current = String(value);
      intervalDirtyRef.current = false;
      await refreshStatsAfterCommit('间隔已保存，统计暂未更新。');
      setNotice('间隔已保存；已安排好的到期时间保持不变。');
    });
  }

  function downloadBackup() {
    void run(async () => {
      const backup = await api.backup();
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `selftrain-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice('完整备份已下载；请妥善保存。');
    });
  }

  function restore() {
    if (!restoreFile) return;
    if (!window.confirm('恢复备份会替换当前所有题目、作答历史和复现计划。此操作无法撤销，确定继续吗？')) return;
    void run(async () => {
      if (restoreFile.size > 50 * 1024 * 1024) throw new ApiRequestError('备份文件不能超过 50 MB。');
      let contents: unknown;
      try {
        contents = JSON.parse(await restoreFile.text());
      } catch {
        throw new ApiRequestError('这不是有效的 JSON 备份文件，现有数据未改变。');
      }
      await api.restore(contents);
      intervalDirtyRef.current = false;
      await refreshStatsAfterCommit('备份已恢复，统计暂未更新。', { forceIntervalValue: true });
      setRestoreFile(null);
      if (restoreInput.current) restoreInput.current.value = '';
      setNotice('备份已恢复，题库和复现状态已更新。');
      setPage('home');
    }, { sessionAction: true, retryOnError: 'session' });
  }

  function openSummary(id: string) {
    void run(async () => {
      setSummary(await api.summary(id));
      setPage('summary');
    });
  }

  const tabs: Array<{ page: Page; label: string }> = [
    { page: 'home', label: '工作台' },
    { page: 'import', label: '导入题目' },
    { page: 'history', label: '学习记录' },
    { page: 'settings', label: '数据与设置' },
  ];

  return <div className="app-frame">
    <aside className="sidebar">
      <button type="button" className="brand" onClick={() => navigate('home')} aria-label="SelfTrain 工作台" disabled={!!view || busy}>
        <span className="brand-sign" aria-hidden="true">S<span>·</span></span>
        <span><strong>SelfTrain</strong><small>学习工作台</small></span>
      </button>
      <div className="nav-caption">{view ? '正在作答' : '导航'}</div>
      {view ? <div className="session-nav"><span className="session-beacon" />第 {view.position} / {view.total} 题<p>本轮进行中，计时不会因切换页面而暂停。</p></div>
        : <nav aria-label="主导航">{tabs.map((tab) => <button key={tab.page} type="button" className={`nav-item ${page === tab.page ? 'active' : ''}`} onClick={() => navigate(tab.page)} disabled={busy} aria-current={page === tab.page ? 'page' : undefined}>{tab.label}</button>)}</nav>}
      <div className="sidebar-footer"><span className="local-dot" /> 数据只保存在这台电脑上</div>
    </aside>
    <div className="workspace">
      <header className="workspace-top"><span>SelfTrain / {page === 'session' ? '作答中' : page === 'summary' ? '本轮总结' : tabs.find((tab) => tab.page === page)?.label}</span><span>专注每一次独立作答</span></header>
      {error && <div className="message message-error" role="alert"><div><strong>{error.message}</strong>{!!error.details.length && <ul>{error.details.map((detail, index) => <li key={index}>{detail}</li>)}</ul>}{error.recovery && <button type="button" className="inline-link" onClick={() => void retryRecovery(error.recovery!)} disabled={busy}>{error.recovery === 'session' ? '同步当前进度' : error.recovery === 'stats' ? '重试统计' : '重试读取总结'}</button>}</div><button type="button" aria-label="关闭错误提示" onClick={() => setError(null)}>×</button></div>}
      {notice && <div className="message message-success" role="status"><span>{notice}</span><button type="button" aria-label="关闭提示" onClick={() => setNotice('')}>×</button></div>}
      {loading ? <main className="main-content loading-state"><p>正在连接本地题库…</p></main> : !stats ? <main className="main-content loading-state"><h1>暂时无法读取题库</h1><p>确认本地服务已启动后刷新页面。</p><button type="button" className="secondary-button" onClick={() => window.location.reload()}>重新连接</button></main> : (
        <>
          {page === 'home' && <Dashboard stats={stats} busy={busy} onStart={start} onImport={() => navigate('import')} />}
          {page === 'session' && view && <Quiz view={view} busy={busy} onAnswer={answer} onNext={next} onEnd={end} onExpire={expire} />}
          {page === 'summary' && summary && <Summary summary={summary} onHome={() => navigate('home')} onHistory={() => navigate('history')} />}
          {page === 'summary' && !summary && summaryRecoveryId && <main className="main-content summary-page"><header className="page-heading"><span className="section-label">本轮总结</span><h1>本轮已结束。</h1><p>{summaryLoading ? '正在读取本轮总结…' : '结束状态已保存，暂时无法读取总结内容。'}</p></header>{!summaryLoading && <button type="button" className="primary-button" onClick={() => void retryRecovery('summary')} disabled={busy}>重试读取总结 <span aria-hidden="true">↗</span></button>}</main>}
          {page === 'history' && <History stats={stats} onOpenSummary={openSummary} />}
          {page === 'import' && <main className="main-content form-page">
            <header className="page-heading"><span className="section-label">导入题目</span><h1>让新题进入题库。</h1><p>选择 Agent 生成的 JSONL 文件；系统检查格式后直接导入，不预览或判断答案是否正确。</p></header>
            <section className="form-section"><span className="section-label">你的文件</span><h2>批量导入 JSONL</h2><p>每行一道四选一题，必须包含时限、正确答案和解析。单次最多 5000 道题、5 MB；空行不计入题目数量。有错误则整批不导入。</p>
              <label className={`file-picker${draggingFiles ? ' is-dragging' : ''}`} onDragOver={(event) => { event.preventDefault(); if (!busy) setDraggingFiles(true); }} onDragLeave={() => setDraggingFiles(false)} onDrop={(event) => { event.preventDefault(); setDraggingFiles(false); if (!busy) setImportFiles((prior) => [...prior, ...Array.from(event.dataTransfer.files)]); }}><span>选择或拖入 .jsonl 文件（可多选）</span><input ref={fileInput} type="file" multiple accept=".jsonl,.txt,application/json,text/plain" disabled={busy} onChange={(event) => setImportFiles((prior) => [...prior, ...Array.from(event.target.files ?? [])])} /><strong>{importFiles.length ? `${importFiles.length} 个文件（${(importFiles.reduce((total, file) => total + file.size, 0) / (1024 * 1024)).toFixed(2)} MB）：${importFiles.map((file) => file.name).join('、')}` : '尚未选择文件'}</strong></label>
              <button type="button" className="primary-button" disabled={!importFiles.length || busy} onClick={importSelected}>导入所选文件 <span aria-hidden="true">↗</span></button>
            </section>
            <section className="form-section form-secondary"><span className="section-label">先试一轮</span><h2>内置的 30 道 Go 示例题</h2><p>覆盖切片、接口、并发等常见语法。直接导入即可开始完整的一轮；再次导入相同题目不会清空历史。</p><button type="button" className="secondary-button" disabled={busy} onClick={importExample}>导入 Go 示例题</button></section>
            {importResult && <div className="import-summary"><p>本次处理 {importResult.total} 道：新增 {importResult.imported} 道，跳过 {importResult.skipped} 道。</p>{(importResult.duplicates ?? []).map((item, index) => <p key={`${item.file}:${item.line}:${index}`}>{item.file} 第 {item.line} 行：{item.reason === 'id' ? `ID ${item.matchedId} 已存在` : `内容重复${item.matchedId ? `（匹配 ID ${item.matchedId}）` : `（匹配 ${item.matchedFile} 第 ${item.matchedLine} 行）`}`}，已跳过。</p>)}</div>}
          </main>}
          {page === 'settings' && <main className="main-content form-page">
            <header className="page-heading"><span className="section-label">数据与设置</span><h1>间隔可调，记录可带走。</h1><p>题库和历史保存在本机；修改间隔只影响之后产生的复现安排。</p></header>
            <section className="form-section"><span className="section-label">复现计划</span><h2>两次作答之间至少间隔多久？</h2><div className="setting-row"><label>间隔小时数<input type="number" min="1" max="720" step="1" value={intervalValue} disabled={busy} onChange={(event) => { const next = event.target.value; setIntervalValue(next); intervalDirtyRef.current = next !== persistedIntervalRef.current; }} /></label><button type="button" className="primary-button" disabled={busy} onClick={saveInterval}>保存间隔</button></div><p>默认为 24 小时；允许 1–720 小时。已经排好的到期时间不会改变。</p></section>
            <section className="form-section form-secondary"><span className="section-label">完整备份</span><h2>把题库与历史一起保存</h2><p>备份包含题目、作答历史、间隔设置和到期状态。进行中的答题必须先结束，才能备份或恢复。</p><button type="button" className="secondary-button" disabled={busy} onClick={downloadBackup}>下载完整 JSON 备份</button></section>
            <section className="form-section form-danger"><span className="section-label">覆盖恢复</span><h2>从备份文件恢复</h2><p>恢复会替换当前的全部数据。请先下载一份现有备份；系统会在写入前验证文件，失败时原数据保持不变。</p><label className="file-picker"><span>选择备份 .json 文件</span><input ref={restoreInput} type="file" accept=".json,application/json" disabled={busy} onChange={(event) => setRestoreFile(event.target.files?.[0] ?? null)} /><strong>{restoreFile?.name ?? '尚未选择文件'}</strong></label><button type="button" className="secondary-button danger-button" disabled={!restoreFile || busy} onClick={restore}>验证并覆盖恢复</button></section>
          </main>}
        </>
      )}
    </div>
  </div>;
}
