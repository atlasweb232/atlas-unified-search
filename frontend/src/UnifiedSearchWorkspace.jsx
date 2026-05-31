import React, { useEffect, useMemo, useState } from 'react';
import { Bot, ChevronDown, ChevronRight, FileDown, Loader2, Search, Send, Sparkles } from 'lucide-react';
import { apiRequest, sourceMeta } from './api.js';

const DEFAULT_SOURCES = ['email', 'slack', 'google_drive', 'conference_bridge', 'knowledge_base', 'data_fabric'];

export function UnifiedSearchWorkspace({ apiBaseUrl = '', tenantId, userId }) {
  const [connectors, setConnectors] = useState([]);
  const [selectedSources, setSelectedSources] = useState(new Set(DEFAULT_SOURCES));
  const [query, setQuery] = useState('');
  const [run, setRun] = useState(null);
  const [results, setResults] = useState([]);
  const [expanded, setExpanded] = useState(new Set());
  const [selectedResults, setSelectedResults] = useState(new Set());
  const [assistantPrompt, setAssistantPrompt] = useState('');
  const [assistantJobs, setAssistantJobs] = useState([]);
  const [state, setState] = useState({ loading: false, error: '' });

  useEffect(() => {
    apiRequest(apiBaseUrl, '/v1/connectors')
      .then((data) => setConnectors(data.connectors || []))
      .catch((error) => setState((current) => ({ ...current, error: error.message })));
  }, [apiBaseUrl]);

  const sourceStatuses = useMemo(() => Object.fromEntries((run?.sourceStatuses || []).map((item) => [item.source, item])), [run]);

  async function startSearch(event) {
    event?.preventDefault();
    setState({ loading: true, error: '' });
    setResults([]);
    setRun(null);
    try {
      const data = await apiRequest(apiBaseUrl, '/v1/search-runs', {
        method: 'POST',
        body: JSON.stringify({
          tenantId,
          userId,
          query,
          sources: [...selectedSources],
          wait: true,
          limit: 25,
        }),
      });
      setRun(data.searchRun);
      setResults(data.results || []);
      setSelectedResults(new Set((data.results || []).slice(0, 3).map((result) => result.id)));
      setState({ loading: false, error: '' });
    } catch (error) {
      setState({ loading: false, error: error.message });
    }
  }

  async function runAssistant(actionType) {
    if (!run || selectedResults.size === 0) return;
    setState((current) => ({ ...current, error: '' }));
    try {
      const data = await apiRequest(apiBaseUrl, '/v1/assistant/actions', {
        method: 'POST',
        body: JSON.stringify({
          tenantId,
          userId,
          searchRunId: run.id,
          actionType,
          selectedResultIds: [...selectedResults],
          prompt: assistantPrompt,
        }),
      });
      setAssistantJobs((current) => [data.actionJob, ...current]);
    } catch (error) {
      setState((current) => ({ ...current, error: error.message }));
    }
  }

  function toggleSource(source) {
    setSelectedSources((current) => {
      const next = new Set(current);
      if (next.has(source)) next.delete(source);
      else next.add(source);
      return next;
    });
  }

  function toggleExpanded(id) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelected(id) {
    setSelectedResults((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="workspace">
      <aside className="source-panel">
        <div className="brand">
          <Sparkles size={22} />
          <div>
            <strong>Atlas Search</strong>
            <span>{tenantId} / {userId}</span>
          </div>
        </div>
        <h2>Connectors</h2>
        <div className="connector-list">
          {DEFAULT_SOURCES.map((source) => {
            const connector = connectors.find((item) => item.source === source);
            const status = sourceStatuses[source];
            return (
              <label key={source} className="connector-row">
                <input type="checkbox" checked={selectedSources.has(source)} onChange={() => toggleSource(source)} />
                <span className="source-icon">{sourceMeta[source]?.icon || 'SRC'}</span>
                <span className="connector-main">
                  <strong>{sourceMeta[source]?.label || source}</strong>
                  <small>{status?.status || (connector?.configured ? 'configured' : 'not configured')}</small>
                </span>
              </label>
            );
          })}
        </div>
      </aside>

      <main className="result-panel">
        <form className="search-bar" onSubmit={startSearch}>
          <Search size={20} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search email, Slack, Drive, meetings, knowledge, and data fabric" />
          <button type="submit" disabled={state.loading || !query.trim()}>
            {state.loading ? <Loader2 className="spin" size={18} /> : <Search size={18} />}
            Search
          </button>
        </form>

        {state.error && <div className="error">{state.error}</div>}

        <div className="status-row">
          {DEFAULT_SOURCES.filter((source) => selectedSources.has(source)).map((source) => (
            <span key={source}>{sourceMeta[source]?.label}: {sourceStatuses[source]?.status || 'idle'}</span>
          ))}
        </div>

        <section className="results">
          {results.map((result) => (
            <article key={result.id} className={`result ${selectedResults.has(result.id) ? 'selected' : ''}`}>
              <div className="result-line">
                <input type="checkbox" checked={selectedResults.has(result.id)} onChange={() => toggleSelected(result.id)} />
                <button type="button" className="expand" onClick={() => toggleExpanded(result.id)}>
                  {expanded.has(result.id) ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                </button>
                <span className="source-icon">{sourceMeta[result.source]?.icon || result.sourceIcon || 'SRC'}</span>
                <div className="result-main">
                  <div className="meta">
                    <span>{result.sourceLabel || sourceMeta[result.source]?.label}</span>
                    <span>{result.container}</span>
                    <span>{result.author}</span>
                    <span>{formatDate(result.timestamp)}</span>
                    <span>{Math.round((result.score || 0) * 100)}%</span>
                  </div>
                  <strong>{result.title}</strong>
                  <p>{result.oneLine}</p>
                </div>
              </div>
              {expanded.has(result.id) && (
                <div className="result-detail">
                  {Boolean(result.links?.length) && <Detail title="Links" items={result.links} />}
                  {Boolean(result.attachments?.length) && <Detail title="Attachments" items={result.attachments.map((item) => item.name || item.title || JSON.stringify(item))} />}
                  {Boolean(result.children?.length) && <Detail title="Related context" items={result.children.map((item) => `${item.title || item.kind || 'item'}: ${item.text || item.summary || ''}`)} />}
                </div>
              )}
            </article>
          ))}
          {!state.loading && results.length === 0 && <div className="empty">Run a search to see unified results.</div>}
        </section>
      </main>

      <aside className="assistant-panel">
        <div className="assistant-title">
          <Bot size={22} />
          <div>
            <strong>Assistant</strong>
            <span>{selectedResults.size} selected result(s)</span>
          </div>
        </div>
        <textarea value={assistantPrompt} onChange={(event) => setAssistantPrompt(event.target.value)} placeholder="Ask for a summary, briefing, comparison, or report..." />
        <div className="action-grid">
          <button onClick={() => runAssistant('summarize')} disabled={!run || selectedResults.size === 0}><Send size={15} />Summarize</button>
          <button onClick={() => runAssistant('answer_question')} disabled={!run || selectedResults.size === 0}><Send size={15} />Ask</button>
          <button onClick={() => runAssistant('create_powerpoint')} disabled={!run || selectedResults.size === 0}><FileDown size={15} />PowerPoint</button>
          <button onClick={() => runAssistant('create_pdf')} disabled={!run || selectedResults.size === 0}><FileDown size={15} />PDF</button>
        </div>
        <div className="assistant-jobs">
          {assistantJobs.map((job) => (
            <div key={job.id} className="job">
              <strong>{job.actionType}</strong>
              <small>{job.status}</small>
              <p>{job.responseText}</p>
              {Boolean(job.artifactIds?.length) && <small>Artifacts: {job.artifactIds.join(', ')}</small>}
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}

function Detail({ title, items }) {
  return (
    <section className="detail">
      <strong>{title}</strong>
      {items.map((item, index) => <p key={`${title}-${index}`}>{String(item)}</p>)}
    </section>
  );
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown time';
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
