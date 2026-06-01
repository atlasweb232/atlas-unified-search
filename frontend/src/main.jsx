import React from 'react';
import { createRoot } from 'react-dom/client';
import { UnifiedSearchWorkspace } from './UnifiedSearchWorkspace.jsx';
import './styles.css';

const runtimeParams = new URLSearchParams(window.location.search);
const runtimeConfig = {
  apiBaseUrl: runtimeParams.get('apiBaseUrl') || localStorage.getItem('atlas_unified_search_api_base') || import.meta.env.VITE_UNIFIED_SEARCH_API_BASE || '',
  tenantId: runtimeParams.get('tenantId') || localStorage.getItem('atlas_unified_search_tenant_id') || import.meta.env.VITE_UNIFIED_SEARCH_TENANT_ID || 'atlasweb',
  userId: runtimeParams.get('userId') || localStorage.getItem('atlas_unified_search_user_id') || import.meta.env.VITE_UNIFIED_SEARCH_USER_ID || '',
};

for (const [key, value] of Object.entries({
  atlas_unified_search_api_base: runtimeConfig.apiBaseUrl,
  atlas_unified_search_tenant_id: runtimeConfig.tenantId,
  atlas_unified_search_user_id: runtimeConfig.userId,
})) {
  if (value) localStorage.setItem(key, value);
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <UnifiedSearchWorkspace
      apiBaseUrl={runtimeConfig.apiBaseUrl}
      tenantId={runtimeConfig.tenantId}
      userId={runtimeConfig.userId || 'user-required'}
    />
  </React.StrictMode>,
);
