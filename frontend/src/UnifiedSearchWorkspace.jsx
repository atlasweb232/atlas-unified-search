import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, ChevronDown, ChevronRight, FileDown, Loader2, RefreshCw, RotateCcw, Search, Send, Sparkles, Trash2 } from 'lucide-react';
import { apiRequest, sourceMeta } from './api.js';

const DEFAULT_SOURCES = ['email', 'slack', 'google_drive', 'conference_bridge', 'knowledge_base', 'data_fabric'];

export function UnifiedSearchWorkspace({ apiBaseUrl = '', tenantId, userId }) {
  const [connectors, setConnectors] = useState([]);
  const [readiness, setReadiness] = useState([]);
  const [setup, setSetup] = useState([]);
  const [selectedSources, setSelectedSources] = useState(new Set());
  const [query, setQuery] = useState('');
  const [authToken, setAuthToken] = useState(() => localStorage.getItem('atlas_unified_search_auth_token') || '');
  const [run, setRun] = useState(null);
  const [results, setResults] = useState([]);
  const [expanded, setExpanded] = useState(new Set());
  const [selectedResults, setSelectedResults] = useState(new Set());
  const [assistantPrompt, setAssistantPrompt] = useState('');
  const [assistantJobs, setAssistantJobs] = useState([]);
  const [state, setState] = useState({ loading: false, error: '' });
  const [maintenance, setMaintenance] = useState({ source: '', busy: false, message: '' });
  const initializedSourceSelection = useRef(false);

  useEffect(() => {
    loadConnectors();
  }, [apiBaseUrl, authToken]);

  async function loadConnectors() {
    setState((current) => ({ ...current, error: '' }));
    try {
      const [connectorData, readinessData, setupData] = await Promise.all([
        apiRequest(apiBaseUrl, '/v1/connectors', { authToken }),
        apiRequest(apiBaseUrl, '/v1/connectors/readiness', { authToken }),
        apiRequest(apiBaseUrl, '/v1/connectors/setup', { authToken }).catch(() => ({ setup: [] })),
      ]);
      setConnectors(connectorData.connectors || []);
      const checks = readinessData.checks || [];
      setReadiness(checks);
      setSetup(setupData.setup || []);
      setSelectedSources((current) => {
        const readySources = new Set(checks.filter((check) => check.ready).map((check) => check.source));
        if (!initializedSourceSelection.current) {
          initializedSourceSelection.current = true;
          return readySources;
        }
        return new Set([...current].filter((source) => readySources.has(source)));
      });
    } catch (error) {
      setState((current) => ({ ...current, error: error.message }));
    }
  }

  function saveAuthToken(value) {
    setAuthToken(value);
    if (value) localStorage.setItem('atlas_unified_search_auth_token', value);
    else localStorage.removeItem('atlas_unified_search_auth_token');
  }

  const sourceStatuses = useMemo(() => Object.fromEntries((run?.sourceStatuses || []).map((item) => [item.source, item])), [run]);
  const readinessBySource = useMemo(() => Object.fromEntries(readiness.map((item) => [item.source, item])), [readiness]);
  const setupBySource = useMemo(() => Object.fromEntries(setup.map((item) => [item.source, item])), [setup]);

  async function startSearch(event) {
    event?.preventDefault();
    setState({ loading: true, error: '' });
    setResults([]);
    setRun(null);
    try {
      const data = await apiRequest(apiBaseUrl, '/v1/search-runs', {
        method: 'POST',
        authToken,
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
        authToken,
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
    if (!canSelectSource(readinessBySource[source])) return;
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

  async function syncSource(source) {
    setMaintenance({ source, busy: true, message: '' });
    try {
      const data = await apiRequest(apiBaseUrl, `/v1/sync/${source}`, {
        method: 'POST',
        authToken,
        body: JSON.stringify({ tenantId, userId, wait: false }),
      });
      setMaintenance({ source, busy: false, message: `Queued ${sourceMeta[source]?.label || source}: ${data.job?.id || 'job accepted'}` });
    } catch (error) {
      setMaintenance({ source, busy: false, message: error.message });
    }
  }

  async function reindexSource(source) {
    if (!window.confirm(`Reset and reindex ${sourceMeta[source]?.label || source} for this user?`)) return;
    setMaintenance({ source, busy: true, message: '' });
    try {
      const data = await apiRequest(apiBaseUrl, `/v1/reindex/${source}`, {
        method: 'POST',
        authToken,
        body: JSON.stringify({ tenantId, userId, wait: false }),
      });
      setMaintenance({ source, busy: false, message: `Reindex queued after deleting ${data.deleted || 0} document(s).` });
      const removedResultIds = new Set(results.filter((result) => result.source === source).map((result) => result.id));
      setResults((current) => current.filter((result) => result.source !== source));
      setSelectedResults((current) => new Set([...current].filter((id) => !removedResultIds.has(id))));
    } catch (error) {
      setMaintenance({ source, busy: false, message: error.message });
    }
  }

  async function clearSource(source) {
    if (!window.confirm(`Delete indexed ${sourceMeta[source]?.label || source} documents for this user?`)) return;
    setMaintenance({ source, busy: true, message: '' });
    try {
      const data = await apiRequest(apiBaseUrl, '/v1/documents', {
        method: 'DELETE',
        authToken,
        body: JSON.stringify({ tenantId, userId, source, resetCheckpoints: true }),
      });
      setMaintenance({ source, busy: false, message: `Deleted ${data.deleted || 0} document(s).` });
      const removedResultIds = new Set(results.filter((result) => result.source === source).map((result) => result.id));
      setResults((current) => current.filter((result) => result.source !== source));
      setSelectedResults((current) => new Set([...current].filter((id) => !removedResultIds.has(id))));
    } catch (error) {
      setMaintenance({ source, busy: false, message: error.message });
    }
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
        <label className="token-field">
          <span>API token</span>
          <input data-testid="api-token-input" type="password" value={authToken} onChange={(event) => saveAuthToken(event.target.value)} placeholder="Bearer token for protected API" />
        </label>
        <button type="button" className="secondary-button" onClick={loadConnectors}>
          <RefreshCw size={15} />
          Refresh
        </button>
        <h2>Connectors</h2>
        <div className="connector-list">
          {DEFAULT_SOURCES.map((source) => {
            const connector = connectors.find((item) => item.source === source);
            const check = readinessBySource[source];
            const setupGuide = setupBySource[source];
            const status = sourceStatuses[source];
            const liveBlocked = isLiveCredentialBlocked(source, check);
            const selectable = canSelectSource(check);
            return (
              <div key={source} data-testid={`connector-${source}`} className={`connector-card ${check?.ready ? 'ready' : ''} ${liveBlocked ? 'blocked' : ''}`}>
                <label className="connector-row">
                  <input
                    data-testid={`source-toggle-${source}`}
                    type="checkbox"
                    checked={selectable && selectedSources.has(source)}
                    onChange={() => toggleSource(source)}
                    disabled={!selectable}
                    title={selectable ? 'Include this source in search' : 'Source is unavailable until readiness passes'}
                  />
                  <span className="source-icon">{sourceMeta[source]?.icon || 'SRC'}</span>
                  <span className="connector-main">
                    <strong>{sourceMeta[source]?.label || source}</strong>
                    <small>{connectorStatusLabel(source, check, connector, status)}</small>
                    <span className={`mode-badge ${connector?.vectorizationMode === 'external_federated' ? 'federated' : 'indexed'}`}>
                      {connector?.vectorizationMode === 'external_federated' ? 'Federated vector space' : 'Indexed here'}
                    </span>
                  </span>
                </label>
                <div className="connector-actions">
                  <button type="button" title="Sync source" onClick={() => syncSource(source)} disabled={maintenance.busy || !check?.ready}>
                    <RefreshCw size={14} />
                  </button>
                  <button type="button" title="Reset and reindex source" onClick={() => reindexSource(source)} disabled={maintenance.busy || !check?.ready}>
                    <RotateCcw size={14} />
                  </button>
                  <button type="button" title="Delete indexed source data" onClick={() => clearSource(source)} disabled={maintenance.busy}>
                    <Trash2 size={14} />
                  </button>
                </div>
                {Boolean(check?.requirements?.length) && (
                  <div className="requirements">
                    {check.requirements.map((requirement) => (
                      <span key={`${source}-${requirement.name}`} className={requirement.configured ? 'ok' : ''}>{requirement.name}</span>
                    ))}
                  </div>
                )}
                {setupGuide && !setupGuide.ready && (
                  <p className="setup-hint">{setupGuide.nextAction}</p>
                )}
                {liveBlocked && (
                  <p className="setup-hint auth-boundary">This source is unavailable for search, sync, and reindex until live authentication passes readiness.</p>
                )}
                {setupGuide?.ready && setupGuide.vectorizationBoundary && (
                  <p className="setup-hint">{setupGuide.vectorizationBoundary}</p>
                )}
              </div>
            );
          })}
        </div>
        {maintenance.message && <div className="maintenance-message">{maintenance.message}</div>}
      </aside>

      <main className="result-panel">
        <form className="search-bar" onSubmit={startSearch}>
          <Search size={20} />
          <input data-testid="search-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search email, Slack, Drive, meetings, knowledge, and data fabric" />
          <button data-testid="search-submit" type="submit" disabled={state.loading || !query.trim()}>
            {state.loading ? <Loader2 className="spin" size={18} /> : <Search size={18} />}
            Search
          </button>
        </form>

        {state.error && <div className="error">{state.error}</div>}

        <div className="status-row">
          {DEFAULT_SOURCES.filter((source) => selectedSources.has(source)).map((source) => (
            <span key={source}>{sourceMeta[source]?.label}: {formatSourceStatus(sourceStatuses[source]) || 'idle'}</span>
          ))}
        </div>

        <section className="results">
          {results.map((result) => (
            <article key={result.id} data-testid="result-row" className={`result ${selectedResults.has(result.id) ? 'selected' : ''}`}>
              <div className="result-line">
                <input type="checkbox" checked={selectedResults.has(result.id)} onChange={() => toggleSelected(result.id)} />
                <button type="button" data-testid="result-expand" className="expand" onClick={() => toggleExpanded(result.id)}>
                  {expanded.has(result.id) ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                </button>
                <span className="source-icon">{sourceMeta[result.source]?.icon || result.sourceIcon || 'SRC'}</span>
                <div className="result-main">
                  <div className="meta">
                    <span>{result.sourceLabel || sourceMeta[result.source]?.label}</span>
                    <span>{displayValue(result.container)}</span>
                    <span>{displayValue(result.author)}</span>
                    <span>{formatDate(result.timestamp)}</span>
                    <span>{Math.round((result.score || 0) * 100)}%</span>
                  </div>
                  <strong>{displayValue(result.title)}</strong>
                  <p>{displayValue(result.oneLine)}</p>
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
        <textarea data-testid="assistant-prompt" value={assistantPrompt} onChange={(event) => setAssistantPrompt(event.target.value)} placeholder="Ask for a summary, briefing, comparison, or report..." />
        <div className="action-grid">
          <button data-testid="assistant-summarize" onClick={() => runAssistant('summarize')} disabled={!run || selectedResults.size === 0}><Send size={15} />Summarize</button>
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

function displayValue(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(displayValue).filter(Boolean).join(', ');
  if (typeof value === 'object') return value.name || value.email || value.address || value.label || JSON.stringify(value);
  return String(value);
}

function formatSourceStatus(status) {
  if (!status?.status) return '';
  if (status.status === 'completed' && status.searchMode === 'local_index_only') return 'completed, indexed data only';
  if (status.status === 'completed' && status.searchMode === 'federated_live') return 'completed, live federated';
  if (status.status === 'running' && status.searchMode === 'local_index_only') return 'running, indexed data only';
  if (status.status === 'running' && status.searchMode === 'federated_live') return 'running, live federated';
  return status.status;
}

function connectorStatusLabel(source, check, connector, status) {
  const runStatus = formatSourceStatus(status);
  if (runStatus) return runStatus;
  if (isLiveCredentialBlocked(source, check)) return 'not authenticated';
  return check?.status || (connector?.configured ? 'configured' : 'not configured');
}

function canSelectSource(check) {
  return Boolean(check?.ready);
}

function isLiveCredentialBlocked(source, check) {
  return ['slack', 'google_drive'].includes(source) && !check?.ready;
}
