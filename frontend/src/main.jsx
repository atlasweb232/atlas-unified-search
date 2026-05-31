import React from 'react';
import { createRoot } from 'react-dom/client';
import { UnifiedSearchWorkspace } from './UnifiedSearchWorkspace.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <UnifiedSearchWorkspace
      apiBaseUrl={import.meta.env.VITE_UNIFIED_SEARCH_API_BASE || ''}
      tenantId={import.meta.env.VITE_UNIFIED_SEARCH_TENANT_ID || 'atlasweb'}
      userId={import.meta.env.VITE_UNIFIED_SEARCH_USER_ID || 'local-user'}
    />
  </React.StrictMode>,
);
