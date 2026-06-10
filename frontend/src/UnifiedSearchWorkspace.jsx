import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Bot,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Database,
  FileDown,
  HardDrive,
  Loader2,
  Mail,
  MessageSquare,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Sparkles,
  Trash2,
  Video,
  XCircle,
} from 'lucide-react';
import { apiRequest, apiStream, sourceMeta } from './api.js';

const DEFAULT_SOURCES = ['email', 'slack', 'google_drive', 'conference_bridge', 'knowledge_base', 'data_fabric'];

export function UnifiedSearchWorkspace({ apiBaseUrl = '', tenantId, userId }) {
  const [connectors, setConnectors] = useState([]);
  const [readiness, setReadiness] = useState([]);
  const [setup, setSetup] = useState([]);
  const [selectedSources, setSelectedSources] = useState(new Set());
  const [query, setQuery] = useState('');
  const [authToken, setAuthToken] = useState(() => localStorage.getItem('atlas_unified_search_auth_token') || '');
  const [scope, setScope] = useState({ tenantId, userId });
  const [connectionState, setConnectionState] = useState({});
  const [observability, setObservability] = useState({ index: null, jobs: [], events: [] });
  const [run, setRun] = useState(null);
  const [results, setResults] = useState([]);
  const [expanded, setExpanded] = useState(new Set());
  const [selectedResults, setSelectedResults] = useState(new Set());
  const [assistantPrompt, setAssistantPrompt] = useState('');
  const [assistantJobs, setAssistantJobs] = useState([]);
  const [retrievalSummary, setRetrievalSummary] = useState(null);
  const [recentSearches, setRecentSearches] = useState([]);
  const [state, setState] = useState({ loading: false, error: '' });
  const [maintenance, setMaintenance] = useState({ source: '', busy: false, message: '' });
  const initializedSourceSelection = useRef(false);
  const oauthPopup = useRef(null);
  const pendingOAuthSource = useRef('');

  useEffect(() => {
    loadConnectors();
  }, [apiBaseUrl, authToken, scope.tenantId, scope.userId]);

  useEffect(() => {
    const receiveOAuth = (event) => {
      const apiOrigin = new URL(apiBaseUrl || window.location.origin, window.location.origin).origin;
      if (![window.location.origin, apiOrigin].includes(event.origin) || event.data?.type !== 'atlas-unified-search-oauth') return;
      const next = event.data;
      saveAuthToken(next.token || '');
      const nextScope = {
        tenantId: next.tenantId || scope.tenantId,
        userId: next.userId || scope.userId,
      };
      setScope(nextScope);
      localStorage.setItem('atlas_unified_search_tenant_id', nextScope.tenantId);
      localStorage.setItem('atlas_unified_search_user_id', nextScope.userId);
      setConnectionState((current) => ({
        ...current,
        [pendingOAuthSource.current]: { status: 'connected', message: 'Connected' },
      }));
      oauthPopup.current = null;
      pendingOAuthSource.current = '';
    };
    window.addEventListener('message', receiveOAuth);
    return () => window.removeEventListener('message', receiveOAuth);
  }, [apiBaseUrl, scope.tenantId, scope.userId]);

  useEffect(() => {
    if (!authToken || !scope.tenantId || !scope.userId) return undefined;
    refreshObservability();
    const timer = window.setInterval(refreshObservability, 5000);
    return () => window.clearInterval(timer);
  }, [authToken, scope.tenantId, scope.userId]);

  async function loadConnectors() {
    setState((current) => ({ ...current, error: '' }));
    if (!authToken) {
      setReadiness([]);
      setSelectedSources(new Set());
      return;
    }
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
      setConnectionState((current) => {
        const next = { ...current };
        for (const source of DEFAULT_SOURCES) {
          const check = checks.find((item) => item.source === source);
          if (check?.ready) next[source] = { status: 'connected', message: 'Connected' };
          else if (authToken && check) next[source] = { status: 'failed', message: 'Connection failed' };
        }
        return next;
      });
      setSelectedSources((current) => {
        const readySources = new Set(checks.filter((check) => check.ready).map((check) => check.source));
        if (!initializedSourceSelection.current) {
          initializedSourceSelection.current = true;
          return readySources;
        }
        return new Set([...current].filter((source) => readySources.has(source)));
      });
      await loadRecentSearches();
    } catch (error) {
      setState((current) => ({ ...current, error: error.message }));
    }
  }

  async function loadRecentSearches() {
    if (!authToken || !scope.tenantId || !scope.userId) return;
    const encodedScope = `tenantId=${encodeURIComponent(scope.tenantId)}&userId=${encodeURIComponent(scope.userId)}`;
    const data = await apiRequest(apiBaseUrl, `/v1/search-runs?${encodedScope}&limit=8`, { authToken });
    setRecentSearches((data.runs || []).filter((item) => ['completed', 'partial'].includes(item.status)));
  }

  async function refreshObservability() {
    try {
      const encodedScope = `tenantId=${encodeURIComponent(scope.tenantId)}&userId=${encodeURIComponent(scope.userId)}`;
      const [indexData, jobData, auditData] = await Promise.all([
        apiRequest(apiBaseUrl, `/v1/index/status?${encodedScope}`, { authToken }),
        apiRequest(apiBaseUrl, `/v1/jobs?${encodedScope}`, { authToken }),
        apiRequest(apiBaseUrl, `/v1/audit?${encodedScope}&limit=12`, { authToken }),
      ]);
      setObservability({
        index: indexData.index || null,
        jobs: (jobData.jobs || []).slice(0, 6),
        events: (auditData.events || []).slice(0, 8),
      });
    } catch (error) {
      setObservability((current) => ({ ...current, error: error.message }));
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

  function openOAuth(source) {
    const provider = source === 'slack' ? 'slack' : 'gdrive';
    const width = 620;
    const height = 760;
    const left = Math.max(0, window.screenX + (window.outerWidth - width) / 2);
    const top = Math.max(0, window.screenY + (window.outerHeight - height) / 2);
    pendingOAuthSource.current = source;
    setConnectionState((current) => ({
      ...current,
      [source]: { status: 'connecting', message: 'Connecting...' },
    }));
    const popup = window.open(
      `${apiBaseUrl}/v1/onboarding/oauth/${provider}/start?redirect=1&returnTo=${encodeURIComponent(window.location.origin)}`,
      `atlas-${provider}-oauth`,
      `popup=yes,width=${width},height=${height},left=${left},top=${top}`,
    );
    oauthPopup.current = popup;
    if (!popup) {
      setConnectionState((current) => ({
        ...current,
        [source]: { status: 'failed', message: 'Connection failed: popup blocked' },
      }));
      return;
    }
    const closedTimer = window.setInterval(() => {
      if (!popup.closed) return;
      window.clearInterval(closedTimer);
      if (pendingOAuthSource.current === source) {
        setConnectionState((current) => ({
          ...current,
          [source]: { status: 'failed', message: 'Connection failed' },
        }));
        pendingOAuthSource.current = '';
      }
    }, 500);
  }

  const signInWithSlack = () => openOAuth('slack');
  const signInWithGoogle = () => openOAuth('google_drive');

  async function connectSource(source) {
    if (source === 'slack' || source === 'google_drive') {
      openOAuth(source);
      return;
    }
    if (!authToken) {
      setConnectionState((current) => ({
        ...current,
        [source]: { status: 'failed', message: 'Connection failed: sign in first' },
      }));
      return;
    }
    setConnectionState((current) => ({
      ...current,
      [source]: { status: 'connecting', message: 'Checking connection...' },
    }));
    try {
      const data = await apiRequest(apiBaseUrl, `/v1/connectors/readiness?source=${encodeURIComponent(source)}`, { authToken });
      const check = data.checks?.find((item) => item.source === source);
      setConnectionState((current) => ({
        ...current,
        [source]: check?.ready
          ? { status: 'connected', message: 'Connected' }
          : { status: 'failed', message: 'Connection failed' },
      }));
      await loadConnectors();
    } catch (error) {
      setConnectionState((current) => ({
        ...current,
        [source]: { status: 'failed', message: 'Connection failed' },
      }));
    }
  }

  function signOut() {
    saveAuthToken('');
    localStorage.removeItem('atlas_unified_search_tenant_id');
    localStorage.removeItem('atlas_unified_search_user_id');
    setConnectionState({});
    setObservability({ index: null, jobs: [], events: [] });
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
    setRetrievalSummary(null);
    try {
      const data = await apiRequest(apiBaseUrl, '/v1/search-runs', {
        method: 'POST',
        authToken,
        body: JSON.stringify({
          tenantId: scope.tenantId,
          userId: scope.userId,
          query,
          sources: [...selectedSources],
          wait: false,
          limit: 25,
        }),
      });
      setRun(data.searchRun);
      setResults(data.results || []);
      await loadRecentSearches();
      await streamSearchRun(data.searchRun.id);
    } catch (error) {
      setState({ loading: false, error: error.message });
    }
  }

  async function streamSearchRun(searchRunId) {
    const path = `/v1/search-runs/${encodeURIComponent(searchRunId)}/events?tenantId=${encodeURIComponent(scope.tenantId)}&userId=${encodeURIComponent(scope.userId)}`;
    await apiStream(apiBaseUrl, path, { authToken }, ({ event, data }) => {
      if (event === 'error' || event === 'timeout') throw new Error(data.error || 'Search stream failed');
      if (!data.searchRun) return;
      setRun(data.searchRun);
      setResults(data.results || []);
      setSelectedResults(new Set((data.results || []).slice(0, 3).map((result) => result.id)));
      if (['completed', 'partial', 'failed'].includes(data.searchRun.status)) {
        setState({ loading: false, error: data.searchRun.status === 'failed' ? 'Search run failed.' : '' });
        void loadRecentSearches();
      }
    });
  }

  async function runAssistant(actionType) {
    if (!run || results.length === 0) return;
    const resultIds = actionType === 'summarize'
      ? results.map((result) => result.id)
      : [...selectedResults];
    if (!resultIds.length) return;
    setState((current) => ({ ...current, error: '' }));
    try {
      const data = await apiRequest(apiBaseUrl, '/v1/assistant/actions', {
        method: 'POST',
        authToken,
        body: JSON.stringify({
          tenantId: scope.tenantId,
          userId: scope.userId,
          searchRunId: run.id,
          actionType,
          selectedResultIds: resultIds,
          prompt: assistantPrompt,
        }),
      });
      setAssistantJobs((current) => [data.actionJob, ...current]);
      if (actionType === 'summarize') setRetrievalSummary(data.actionJob);
    } catch (error) {
      setState((current) => ({ ...current, error: error.message }));
    }
  }

  function restoreSearch(searchRun) {
    setQuery(searchRun.query || '');
    setRun(searchRun);
    setResults(searchRun.results || []);
    setSelectedSources(new Set(searchRun.selectedSources || []));
    setSelectedResults(new Set((searchRun.results || []).slice(0, 3).map((result) => result.id)));
    setExpanded(new Set());
    setRetrievalSummary(null);
    setState({ loading: false, error: '' });
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
        body: JSON.stringify({ tenantId: scope.tenantId, userId: scope.userId, wait: false }),
      });
      setMaintenance({ source, busy: false, message: `Queued ${sourceMeta[source]?.label || source}: ${data.job?.id || 'job accepted'}` });
      await refreshObservability();
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
        body: JSON.stringify({ tenantId: scope.tenantId, userId: scope.userId, wait: false }),
      });
      setMaintenance({ source, busy: false, message: `Reindex queued after deleting ${data.deleted || 0} document(s).` });
      const removedResultIds = new Set(results.filter((result) => result.source === source).map((result) => result.id));
      setResults((current) => current.filter((result) => result.source !== source));
      setSelectedResults((current) => new Set([...current].filter((id) => !removedResultIds.has(id))));
      await refreshObservability();
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
        body: JSON.stringify({ tenantId: scope.tenantId, userId: scope.userId, resetCheckpoints: true }),
      });
      setMaintenance({ source, busy: false, message: `Deleted ${data.deleted || 0} document(s).` });
      const removedResultIds = new Set(results.filter((result) => result.source === source).map((result) => result.id));
      setResults((current) => current.filter((result) => result.source !== source));
      setSelectedResults((current) => new Set([...current].filter((id) => !removedResultIds.has(id))));
      await refreshObservability();
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
            <span>{scope.tenantId} / {scope.userId}</span>
          </div>
        </div>
        {isSignedIn ? (
          <div className="auth-status">
            <span className="auth-user">{scope.userId}</span>
            <button type="button" className="secondary-button" onClick={signOut}>Sign out</button>
          </div>
        ) : (
          <div className="signin-buttons obsolete-signin-buttons" aria-hidden="true">
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
        {!isSignedIn && <p className="auth-hint">Choose Slack or Google Drive below to sign in without leaving this page.</p>}
        <h2>Connectors</h2>
        <div className="connector-list">
          {DEFAULT_SOURCES.map((source) => {
            const check = readinessBySource[source];
            const connection = connectionState[source] || {};
            const connected = connection.status === 'connected' || check?.ready;
            const selected = connected && selectedSources.has(source);
            return (
              <div key={source} data-testid={`connector-${source}`} className={`connector-tile ${connected ? 'ready' : ''} ${selected ? 'selected' : ''}`}>
                <button
                  type="button"
                  data-testid={`connector-button-${source}`}
                  className="connector-button"
                  onClick={() => connected ? toggleSource(source) : connectSource(source)}
                  aria-pressed={selected}
                >
                  <SourceIcon source={source} />
                  <span className="connector-copy">
                    <strong>{sourceMeta[source]?.label || source}</strong>
                    <small>{connected ? (selected ? 'Included in search' : 'Click to include') : connectorPrompt(source)}</small>
                  </span>
                  {selected && <CheckCircle2 className="selected-check" size={17} />}
                  <span className={`connection-status ${connected ? 'connected' : connection.status || 'idle'}`}>
                    {connectionStatusText(connection, connected)}
                  </span>
                </button>
                <input data-testid={`source-toggle-${source}`} type="checkbox" checked={selected} onChange={() => toggleSource(source)} hidden />
                {connected && (
                  <div className="connector-actions">
                    <button type="button" title="Sync source" onClick={() => syncSource(source)} disabled={maintenance.busy}><RefreshCw size={14} /></button>
                    <button type="button" title="Reset and reindex source" onClick={() => reindexSource(source)} disabled={maintenance.busy}><RotateCcw size={14} /></button>
                    <button type="button" title="Delete indexed source data" onClick={() => clearSource(source)} disabled={maintenance.busy}><Trash2 size={14} /></button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {maintenance.message && <div className="maintenance-message">{maintenance.message}</div>}
        <section className="vector-log" aria-label="Vectorization activity">
          <div className="section-title">
            <Activity size={16} />
            <h2>Vectorization Activity</h2>
            <button type="button" title="Refresh activity" onClick={refreshObservability} disabled={!isSignedIn}><RefreshCw size={13} /></button>
          </div>
          {!isSignedIn && <p className="log-empty">Connect a source to view indexing logs.</p>}
          {isSignedIn && observability.error && <p className="log-error">{observability.error}</p>}
          {isSignedIn && observability.index && (
            <div className="index-summary">
              <span><strong>{observability.index.documents || 0}</strong> documents</span>
              <span><strong>{observability.index.chunks || 0}</strong> chunks</span>
            </div>
          )}
          {isSignedIn && Object.entries(observability.index?.bySource || {}).map(([source, counts]) => (
            <div className="source-count" key={source}>
              <SourceIcon source={source} size={14} />
              <span>{sourceMeta[source]?.label || source}</span>
              <strong>{displayCount(counts)}</strong>
            </div>
          ))}
          {isSignedIn && observability.jobs.map((job) => (
            <div className="activity-entry" key={job.id}>
              <span className={`job-dot ${job.status || ''}`} />
              <span>{sourceMeta[job.source]?.label || job.source || job.type}</span>
              <small>{job.status} · {formatDate(job.updatedAt || job.createdAt)}</small>
            </div>
          ))}
          {isSignedIn && observability.events.map((event) => (
            <div className="activity-entry audit-entry" key={event.id}>
              <span className="job-dot event" />
              <span>{event.eventType || event.action || 'activity'}</span>
              <small>{formatDate(event.createdAt || event.timestamp)}</small>
            </div>
          ))}
        </section>
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

        {recentSearches.length > 0 && (
          <section className="recent-searches" aria-label="Recent searches">
            <strong>Recent searches</strong>
            <div>
              {recentSearches.map((searchRun) => (
                <button type="button" key={searchRun.id} onClick={() => restoreSearch(searchRun)}>
                  <span>{searchRun.query}</span>
                  <small>{searchRun.results?.length || 0} results · {formatDate(searchRun.completedAt || searchRun.createdAt)}</small>
                </button>
              ))}
            </div>
          </section>
        )}

        {retrievalSummary && (
          <section className="main-retrieval-summary" data-testid="retrieval-summary">
            <div>
              <Sparkles size={17} />
              <strong>Summary of these search results</strong>
            </div>
            <p>{retrievalSummary.responseText}</p>
          </section>
        )}

        <section className="results">
          {results.map((result) => (
            <article key={result.id} data-testid="result-row" className={`result ${selectedResults.has(result.id) ? 'selected' : ''}`}>
              <div className="result-line">
                <input type="checkbox" checked={selectedResults.has(result.id)} onChange={() => toggleSelected(result.id)} />
                <button type="button" data-testid="result-expand" className="expand" onClick={() => toggleExpanded(result.id)}>
                  {expanded.has(result.id) ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                </button>
                <SourceIcon source={result.source} />
                <div className="result-main">
                  <div className="result-header">
                    <strong>{displayValue(result.author) || 'Unknown sender'}</strong>
                    <span>{formatDate(result.timestamp)}</span>
                  </div>
                  <div className="result-summary-row">
                    <p>{displayValue(result.oneLine) || displayValue(result.title)}</p>
                    <strong className="relevance">{formatRelevance(result.score)} relevant</strong>
                  </div>
                  <small className="result-context">{result.sourceLabel || sourceMeta[result.source]?.label} · {displayValue(result.container)}</small>
                </div>
              </div>
              {expanded.has(result.id) && (
                <div className="result-detail">
                  <section className="message-body">
                    <strong>{displayValue(result.title)}</strong>
                    <p>{displayValue(result.body) || displayValue(result.oneLine) || 'No full message text was returned.'}</p>
                  </section>
                  {Boolean(result.links?.length) && <Detail title="Links" items={result.links} />}
                  {Boolean(result.attachments?.length) && <Detail title="Attachments" items={result.attachments.map((item) => item.name || item.title || JSON.stringify(item))} />}
                  {Boolean(result.children?.length) && <Detail title="Thread" items={result.children.map((item) => `${item.author || item.title || item.kind || 'Reply'}: ${item.text || item.body || item.summary || ''}`)} />}
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
          <button data-testid="assistant-summarize" onClick={() => runAssistant('summarize')} disabled={!run || results.length === 0}><Send size={15} />Summarize results</button>
          <button onClick={() => runAssistant('answer_question')} disabled={!run || selectedResults.size === 0}><Send size={15} />Ask</button>
          <button onClick={() => runAssistant('create_powerpoint')} disabled={!run || selectedResults.size === 0}><FileDown size={15} />PowerPoint</button>
          <button onClick={() => runAssistant('create_pdf')} disabled={!run || selectedResults.size === 0}><FileDown size={15} />PDF</button>
        </div>
        <div className="assistant-jobs">
          {assistantJobs.map((job) => (
            <div key={job.id} className={`job ${job.actionType === 'summarize' ? 'retrieval-summary' : ''}`}>
              <strong>{job.actionType === 'summarize' ? 'Retrieval summary' : job.actionType}</strong>
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

function SourceIcon({ source, size = 18 }) {
  const props = { size, strokeWidth: 1.9 };
  const icons = {
    email: <Mail {...props} />,
    slack: <SlackIcon size={size} />,
    google_drive: <HardDrive {...props} />,
    conference_bridge: <Video {...props} />,
    knowledge_base: <BookOpen {...props} />,
    data_fabric: <Database {...props} />,
  };
  return <span className={`source-icon source-${source}`}>{icons[source] || <MessageSquare {...props} />}</span>;
}

function SlackIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#36C5F0" d="M9.1 2a2.1 2.1 0 0 1 0 4.2H7V4.1A2.1 2.1 0 0 1 9.1 2Z" />
      <path fill="#36C5F0" d="M9.1 7.3a2.1 2.1 0 0 1 0 4.2h-5a2.1 2.1 0 0 1 0-4.2h5Z" />
      <path fill="#2EB67D" d="M22 9.1a2.1 2.1 0 0 1-4.2 0V7h2.1A2.1 2.1 0 0 1 22 9.1Z" />
      <path fill="#2EB67D" d="M16.7 9.1a2.1 2.1 0 0 1-4.2 0v-5a2.1 2.1 0 0 1 4.2 0v5Z" />
      <path fill="#ECB22E" d="M14.9 22a2.1 2.1 0 0 1 0-4.2H17v2.1a2.1 2.1 0 0 1-2.1 2.1Z" />
      <path fill="#ECB22E" d="M14.9 16.7a2.1 2.1 0 0 1 0-4.2h5a2.1 2.1 0 0 1 0 4.2h-5Z" />
      <path fill="#E01E5A" d="M2 14.9a2.1 2.1 0 0 1 4.2 0V17H4.1A2.1 2.1 0 0 1 2 14.9Z" />
      <path fill="#E01E5A" d="M7.3 14.9a2.1 2.1 0 0 1 4.2 0v5a2.1 2.1 0 0 1-4.2 0v-5Z" />
    </svg>
  );
}

function connectorPrompt(source) {
  if (source === 'slack') return 'Connect Slack';
  if (source === 'google_drive') return 'Connect Google';
  return 'Check connection';
}

function connectionStatusText(connection, connected) {
  if (connected) return <><CheckCircle2 size={13} />Connected</>;
  if (connection.status === 'connecting') return <><Loader2 className="spin" size={13} />Connecting</>;
  if (connection.status === 'failed') return <><XCircle size={13} />Connection failed</>;
  return 'Not connected';
}

function displayCount(value) {
  if (typeof value === 'number') return value;
  return value?.documents ?? value?.count ?? 0;
}

function formatRelevance(value) {
  const score = Number(value || 0);
  const normalized = score <= 1 ? score * 100 : score;
  return `${Math.max(0, Math.min(100, Math.round(normalized)))}%`;
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
