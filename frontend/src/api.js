export async function apiRequest(apiBaseUrl, path, options = {}) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    throw new Error(data.error || data.message || 'Request failed');
  }
  return data;
}

export const sourceMeta = {
  email: { label: 'Email', icon: 'MAIL' },
  slack: { label: 'Slack', icon: 'SL' },
  google_drive: { label: 'GDrive', icon: 'GD' },
  conference_bridge: { label: 'Bridge', icon: 'CB' },
  knowledge_base: { label: 'KB', icon: 'KB' },
  data_fabric: { label: 'Fabric', icon: 'DF' },
};
