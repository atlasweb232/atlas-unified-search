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
