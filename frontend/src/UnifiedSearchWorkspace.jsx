import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, ChevronDown, ChevronRight, FileDown, Loader2, RefreshCw, RotateCcw, Search, Send, Sparkles, Trash2 } from 'lucide-react';
import { apiRequest, apiStream, sourceMeta } from './api.js';

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

  // Parse exp from JWT without verification (display only).
  function tokenExpiresAt(token) {
    try {
      const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return payload.exp ? new Date(payload.exp * 1000) : null;
    } catch { return null; }
  }

  // Auto-refresh the token 5 minutes before it expires.
  const scheduleRefresh = useCallback((token) => {
    const exp = tokenExpiresAt(token);
    if (!exp) return;
    const msUntilRefresh = exp.getTime() - Date.now() - 5 * 60 * 1000;
    if (msUntilRefresh <= 0) return;
    const timer = setTimeout(async () => {
      try {
        const data = await apiRequest(apiBaseUrl, '/v1/auth/refresh', {
          method: 'POST', authToken: token,
        });
        if (data.token) { saveAuthToken(data.token); scheduleRefresh(data.token); }
      } catch { /* silent — user re-logs on next expiry */ }
    }, msUntilRefresh);
    return () => clearTimeout(timer);
  }, [apiBaseUrl]);

  useEffect(() => {
    if (authToken) return scheduleRefresh(authToken);
  }, [authToken, scheduleRefresh]);

  function signInWithSlack() {
    window.location.href = `${apiBaseUrl}/v1/onboarding/oauth/slack/start?redirect=1`;
  }

  function signInWithGoogle() {
    window.location.href = `${apiBaseUrl}/v1/onboarding/oauth/gdrive/start?redirect=1`;
  }

  function signOut() {
    saveAuthToken('');
    localStorage.removeItem('atlas_unified_search_tenant_id');
    localStorage.removeItem('atlas_unified_search_user_id');
  }

  const isSignedIn = Boolean(authToken);

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
          wait: false,
          limit: 25,
        }),
      });
      setRun(data.searchRun);
      setResults(data.results || []);
      await streamSearchRun(data.searchRun.id);
    } catch (error) {
      setState({ loading: false, error: error.message });
    }
  }

  async function streamSearchRun(searchRunId) {
    const path = `/v1/search-runs/${encodeURIComponent(searchRunId)}/events?tenantId=${encodeURIComponent(tenantId)}&userId=${encodeURIComponent(userId)}`;
    await apiStream(apiBaseUrl, path, { authToken }, ({ event, data }) => {
      if (event === 'error' || event === 'timeout') throw new Error(data.error || 'Search stream failed');
      if (!data.searchRun) return;
      setRun(data.searchRun);
      setResults(data.results || []);
      setSelectedResults(new Set((data.results || []).slice(0, 3).map((result) => result.id)));
      if (['completed', 'partial', 'failed'].includes(data.searchRun.status)) {
        setState({ loading: false, error: data.searchRun.status === 'failed' ? 'Search run failed.' : '' });
      }
    });
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
      const data = await apiRequest(apiBaseUrl, `/v1/sources/${source}/documents`, {
        method: 'DELETE',
        authToken,
        body: JSON.stringify({ tenantId, userId, resetCheckpoints: true }),
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
        {isSignedIn ? (
          <div className="auth-status">
            <span className="auth-user">{userId}</span>
            <button type="button" className="secondary-button" onClick={signOut}>Sign out</button>
          </div>
        ) : (
          <div className="signin-buttons">
            <button type="button" className="slack-signin-button" onClick={signInWithSlack}>
              <svg width="18" height="18" viewBox="0 0 54 54" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M19.712 33.842a4.286 4.286 0 0 1-4.286 4.286 4.286 4.286 0 0 1-4.286-4.286 4.286 4.286 0 0 1 4.286-4.286h4.286v4.286ZM21.855 33.842a4.286 4.286 0 0 1 4.286-4.286 4.286 4.286 0 0 1 4.286 4.286v10.715a4.286 4.286 0 0 1-4.286 4.286 4.286 4.286 0 0 1-4.286-4.286V33.842Z" fill="#E01E5A"/><path d="M26.141 19.712a4.286 4.286 0 0 1-4.286-4.286 4.286 4.286 0 0 1 4.286-4.286 4.286 4.286 0 0 1 4.286 4.286v4.286h-4.286ZM26.141 21.855a4.286 4.286 0 0 1 4.286 4.286 4.286 4.286 0 0 1-4.286 4.286H15.426a4.286 4.286 0 0 1-4.286-4.286 4.286 4.286 0 0 1 4.286-4.286h10.715Z" fill="#36C5F0"/><path d="M40.271 26.141a4.286 4.286 0 0 1 4.286 4.286 4.286 4.286 0 0 1-4.286 4.286 4.286 4.286 0 0 1-4.286-4.286v-4.286h4.286ZM38.128 26.141a4.286 4.286 0 0 1-4.286-4.286 4.286 4.286 0 0 1 4.286-4.286h10.715a4.286 4.286 0 0 1 4.286 4.286 4.286 4.286 0 0 1-4.286 4.286H38.128Z" fill="#2EB67D"/><path d="M33.842 40.271a4.286 4.286 0 0 1 4.286 4.286 4.286 4.286 0 0 1-4.286 4.286 4.286 4.286 0 0 1-4.286-4.286v-4.286h4.286ZM33.842 38.128a4.286 4.286 0 0 1 4.286-4.286 4.286 4.286 0 0 1 4.286 4.286v10.715a4.286 4.286 0 0 1-4.286 4.286 4.286 4.286 0 0 1-4.286-4.286V38.128Z" fill="#ECB22E"/></svg>
              Sign in with Slack
            </button>
            <button type="button" className="google-signin-button" onClick={signInWithGoogle}>
              <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
              Sign in with Google
            </button>
          </div>
        )}
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
