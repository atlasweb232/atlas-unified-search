export async function apiRequest(apiBaseUrl, path, options = {}) {
  const authToken = options.authToken || localStorage.getItem('atlas_unified_search_auth_token') || '';
  const { authToken: _authToken, ...fetchOptions } = options;
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...fetchOptions,
    headers: {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    const error = new Error(formatApiError(data));
    error.status = response.status;
    error.details = data.details;
    throw error;
  }
  return data;
}

export async function apiStream(apiBaseUrl, path, options = {}, onEvent) {
  const authToken = options.authToken || localStorage.getItem('atlas_unified_search_auth_token') || '';
  const response = await fetch(`${apiBaseUrl}${path}`, {
    headers: {
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...(options.headers || {}),
    },
  });
  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => ({}));
    throw new Error(formatApiError(data));
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';
    for (const eventText of events) {
      const event = parseSseEvent(eventText);
      if (event) onEvent(event);
    }
  }
  if (buffer.trim()) {
    const event = parseSseEvent(buffer);
    if (event) onEvent(event);
  }
}

function parseSseEvent(text) {
  const lines = String(text || '').split('\n');
  const event = lines.find((line) => line.startsWith('event:'))?.slice('event:'.length).trim() || 'message';
  const data = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .join('\n');
  if (!data) return null;
  return { event, data: JSON.parse(data) };
}

function formatApiError(data) {
  const message = data.error || data.message || 'Request failed';
  const missing = Array.isArray(data.details?.missing) && data.details.missing.length
    ? ` Missing: ${data.details.missing.join(', ')}.`
    : '';
  const status = data.details?.status ? ` Status: ${data.details.status}.` : '';
  return `${message}.${status}${missing}`.replace('..', '.');
}

export const sourceMeta = {
  email: { label: 'Email', icon: 'MAIL' },
  slack: { label: 'Slack', icon: 'SL' },
  google_drive: { label: 'GDrive', icon: 'GD' },
  conference_bridge: { label: 'Bridge', icon: 'CB' },
  knowledge_base: { label: 'Knowledge', icon: 'KB' },
  data_fabric: { label: 'Data Fabric', icon: 'DF' },
};
