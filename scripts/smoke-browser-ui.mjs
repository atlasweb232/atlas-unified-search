import { chromium } from 'playwright-core';

const frontend = requireEnv('UNIFIED_SEARCH_LOCAL_FRONTEND_URL').replace(/\/$/, '');
const token = requireEnv('UNIFIED_SEARCH_AUTH_TOKEN');
const executablePath = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const tenantId = process.env.UNIFIED_SEARCH_SMOKE_TENANT_ID || 'atlasweb';
const userId = process.env.UNIFIED_SEARCH_SMOKE_USER_ID || await resolveSmokeUserId();
const readinessBySource = await connectorReadiness();
const dataFabricReady = Boolean(readinessBySource.data_fabric?.ready);
if (dataFabricReady) {
  await apiJson('/v1/reindex/data_fabric', {
    method: 'POST',
    body: {
      tenantId,
      userId,
      wait: true,
      options: {
        dataset: process.env.UNIFIED_SEARCH_SMOKE_DATA_FABRIC_DATASET || 'operational_summary',
        limit: 10,
      },
    },
  });
}

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const browserEvents = [];
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type())) browserEvents.push({ type: message.type(), text: message.text() });
  });
  page.on('pageerror', (error) => {
    browserEvents.push({ type: 'pageerror', text: error.message });
  });
  await page.goto(withRuntimeScope(frontend, { tenantId, userId }), { waitUntil: 'networkidle' });

  await page.getByTestId('api-token-input').fill(token);
  await expectText(page, '[data-testid="connector-email"]', 'Federated vector space');
  const brandText = await page.locator('.brand').textContent();
  await expectText(page, '[data-testid="connector-conference_bridge"]', 'Indexed here');
  await expectText(page, '[data-testid="connector-knowledge_base"]', 'Indexed here');
  const slackReady = Boolean(readinessBySource.slack?.ready);
  const gdriveReady = Boolean(readinessBySource.google_drive?.ready);
  await assertConnectorToggleState(page, 'slack', slackReady, ['SLACK_BOT_TOKEN', 'not authenticated']);
  await assertConnectorToggleState(page, 'google_drive', gdriveReady, ['not authenticated', 'unavailable for search']);

  for (const source of ['slack', 'google_drive', 'conference_bridge', 'knowledge_base', 'data_fabric']) {
    const toggle = page.getByTestId(`source-toggle-${source}`);
    if (!(await toggle.isDisabled()) && await toggle.isChecked()) await toggle.click();
  }
  await page.getByTestId('search-input').fill(process.env.UNIFIED_SEARCH_SMOKE_EMAIL_QUERY || 'readiness');
  await page.getByTestId('search-submit').click();
  try {
    await page.waitForSelector('[data-testid="result-row"]', { timeout: searchResultTimeoutMs() });
  } catch (error) {
    const pageText = await page.locator('body').textContent();
    throw new Error(`UI search produced no result rows. Brand=${JSON.stringify(brandText)} Events=${JSON.stringify(browserEvents)} Text=${JSON.stringify(pageText?.slice(0, 2000))}`);
  }
  const resultCount = await page.locator('[data-testid="result-row"]').count();
  assert(resultCount > 0, 'expected at least one federated email result in UI');

  await page.getByTestId('result-expand').first().click();
  await page.getByTestId('assistant-prompt').fill('Summarize the selected email readiness result.');
  await page.waitForFunction(() => !document.querySelector('[data-testid="assistant-summarize"]')?.disabled, {}, { timeout: searchResultTimeoutMs() });
  await page.getByTestId('assistant-summarize').click();
  await expectText(page, '.assistant-jobs', 'completed', searchResultTimeoutMs());

  let dataFabricResultCount = 0;
  if (dataFabricReady) {
    for (const source of ['email', 'conference_bridge', 'knowledge_base']) {
      const toggle = page.getByTestId(`source-toggle-${source}`);
      if (!(await toggle.isDisabled()) && await toggle.isChecked()) await toggle.click();
    }
    const dataFabricToggle = page.getByTestId('source-toggle-data_fabric');
    assert(!(await dataFabricToggle.isDisabled()), 'Data Fabric source must be selectable when readiness is true');
    if (!(await dataFabricToggle.isChecked())) await dataFabricToggle.click();
    await page.getByTestId('search-input').fill(process.env.UNIFIED_SEARCH_SMOKE_DATA_FABRIC_QUERY || 'unified search index status');
    await page.getByTestId('search-submit').click();
    await page.waitForSelector('[data-testid="result-row"]', { timeout: searchResultTimeoutMs() });
    dataFabricResultCount = await page.locator('[data-testid="result-row"]').count();
    assert(dataFabricResultCount > 0, 'expected at least one Data Fabric result in UI');
    await expectText(page, '[data-testid="result-row"]', 'Data Fabric', 15000);
  }

  console.log(JSON.stringify({
    frontend,
    browser: executablePath,
    checks: [
      'token entry authenticated connector loading',
      'email federated vector badge visible',
      'local-index connector badges visible',
      slackReady ? 'Slack live connector selectable' : 'Slack blocked authentication requirements visible and disabled',
      gdriveReady ? 'Google Drive live connector selectable' : 'Google Drive blocked authentication requirements visible and disabled',
      'email-only UI search returned results',
      'result expansion clicked',
      'assistant summarize action completed',
      ...(dataFabricReady ? ['data-fabric-only UI search returned results'] : ['data-fabric UI search skipped because connector is not ready']),
    ],
    resultCount,
    dataFabricResultCount,
  }, null, 2));
} finally {
  if (dataFabricReady) {
    await apiJson('/v1/sources/data_fabric/documents', {
      method: 'DELETE',
      body: {
        tenantId,
        userId,
        resetCheckpoints: true,
      },
    }).catch(() => {});
  }
  await browser.close();
}

async function expectText(page, selector, text, timeout = 15000) {
  await page.waitForFunction(
    ({ selector, text }) => document.querySelector(selector)?.textContent?.includes(text),
    { selector, text },
    { timeout },
  );
}

async function resolveSmokeUserId() {
  const response = await fetch(`${frontend}/v1/connectors/readiness?source=email`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await response.json().catch(() => ({}));
  const email = body.checks?.find((check) => check.source === 'email');
  return email?.details?.readinessUserEmail || 'user-required';
}

async function connectorReadiness() {
  const body = await apiJson('/v1/connectors/readiness');
  return Object.fromEntries((body.checks || []).map((check) => [check.source, check]));
}

async function assertConnectorToggleState(page, source, ready, blockedTexts) {
  const toggle = page.getByTestId(`source-toggle-${source}`);
  if (ready) {
    assert(!(await toggle.isDisabled()), `${source} source must be selectable when live readiness passes`);
    assert(await toggle.isChecked(), `${source} source should be selected by default when live readiness passes`);
    await expectText(page, `[data-testid="connector-${source}"]`, 'ok');
    return;
  }
  for (const text of blockedTexts) await expectText(page, `[data-testid="connector-${source}"]`, text);
  assert(await toggle.isDisabled(), `${source} source must be disabled until live auth readiness passes`);
  assert(!(await toggle.isChecked()), `${source} source must not be selected before live auth readiness passes`);
}

async function apiJson(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${frontend}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    throw new Error(`${method} ${path} failed: ${response.status} ${data.error || JSON.stringify(data)}`);
  }
  return data;
}

function withRuntimeScope(baseUrl, scope) {
  const url = new URL(baseUrl);
  url.searchParams.set('tenantId', scope.tenantId);
  url.searchParams.set('userId', scope.userId);
  return url.toString();
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function searchResultTimeoutMs() {
  return Number(process.env.UNIFIED_SEARCH_SMOKE_UI_RESULT_TIMEOUT_MS || 90000);
}
