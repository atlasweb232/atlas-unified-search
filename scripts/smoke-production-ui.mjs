const base = requireEnv('UNIFIED_SEARCH_BASE_URL').replace(/\/$/, '');
const token = process.env.UNIFIED_SEARCH_AUTH_TOKEN || '';

const root = await request('/');
assert(root.ok, `frontend root failed: ${root.status}`);
assert(typeof root.data === 'string' && root.data.includes('<div id="root"></div>'), 'frontend root does not look like the React shell');
const assets = [...root.data.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((match) => match[1]);
assert(assets.some((asset) => asset.endsWith('.js')), 'frontend root did not reference a JS bundle');
assert(assets.some((asset) => asset.endsWith('.css')), 'frontend root did not reference a CSS bundle');
console.log('frontend shell ok', { status: root.status, assets: assets.length });

for (const asset of assets) {
  const response = await request(asset);
  assert(response.ok, `frontend asset failed: ${asset} ${response.status}`);
}
console.log('frontend assets ok', { assets });

const jsBundlePath = assets.find((asset) => asset.endsWith('.js'));
const jsBundle = await request(jsBundlePath);
assert(jsBundle.data.includes('Atlas Search'), 'JS bundle does not include the search workspace');
assert(jsBundle.data.includes('atlas_unified_search_auth_token'), 'JS bundle does not include local auth-token support');
assert(jsBundle.data.includes('/v1/connectors/readiness'), 'JS bundle does not call connector readiness');
assert(jsBundle.data.includes('/v1/reindex/'), 'JS bundle does not include reindex support');
console.log('frontend bundle capabilities ok');

const unauth = await request('/v1/connectors');
assert(unauth.status === 401, `expected unauthenticated API route to return 401, got ${unauth.status}`);
console.log('api auth boundary ok');

if (token) {
  const readiness = await request('/v1/connectors/readiness', { token });
  assert(readiness.ok, `readiness failed: ${readiness.status} ${JSON.stringify(readiness.data)}`);
  assert(Array.isArray(readiness.data.checks), 'readiness response did not include checks');
  const email = readiness.data.checks.find((check) => check.source === 'email');
  assert(email?.ready === true, `expected email connector to be ready, got ${JSON.stringify(email)}`);
  console.log('authenticated readiness ok', readiness.data.checks.map((check) => ({
    source: check.source,
    ready: check.ready,
    status: check.status,
  })));
  const production = await request('/v1/production-readiness', { token });
  assert(production.ok, `production readiness failed: ${production.status} ${JSON.stringify(production.data)}`);
  assert(production.data.report?.readyForProductionTesting === true, 'production readiness report is not ready for production testing');
  assert(production.data.report?.credentialBlockedSources?.some((item) => item.source === 'slack'), 'production readiness should report Slack as credential-blocked');
  assert(production.data.report?.credentialBlockedSources?.some((item) => item.source === 'google_drive'), 'production readiness should report Google Drive as credential-blocked');
  console.log('production readiness report ok', {
    readyForProductionTesting: production.data.report.readyForProductionTesting,
    productionComplete: production.data.report.productionComplete,
    credentialBlocked: production.data.report.credentialBlockedSources.map((item) => item.source),
  });
} else {
  console.log('authenticated readiness skipped: UNIFIED_SEARCH_AUTH_TOKEN not set');
}

async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    headers: {
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let data = text;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { status: response.status, ok: response.ok, data };
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
