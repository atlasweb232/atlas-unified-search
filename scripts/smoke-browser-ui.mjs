import { chromium } from 'playwright-core';

const frontend = requireEnv('UNIFIED_SEARCH_LOCAL_FRONTEND_URL').replace(/\/$/, '');
const token = requireEnv('UNIFIED_SEARCH_AUTH_TOKEN');
const executablePath = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const tenantId = process.env.UNIFIED_SEARCH_SMOKE_TENANT_ID || 'atlasweb';
const userId = process.env.UNIFIED_SEARCH_SMOKE_USER_ID || await resolveSmokeUserId();

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
  await expectText(page, '[data-testid="connector-slack"]', 'SLACK_BOT_TOKEN');
  await expectText(page, '[data-testid="connector-slack"]', 'not authenticated');
  await expectText(page, '[data-testid="connector-google_drive"]', 'not authenticated');
  await expectText(page, '[data-testid="connector-google_drive"]', 'unavailable for search');
  assert(await page.getByTestId('source-toggle-slack').isDisabled(), 'Slack source must be disabled until live auth readiness passes');
  assert(await page.getByTestId('source-toggle-google_drive').isDisabled(), 'Google Drive source must be disabled until live auth readiness passes');
  assert(!(await page.getByTestId('source-toggle-slack').isChecked()), 'Slack source must not be selected before live auth readiness passes');
  assert(!(await page.getByTestId('source-toggle-google_drive').isChecked()), 'Google Drive source must not be selected before live auth readiness passes');

  for (const source of ['slack', 'google_drive', 'conference_bridge', 'knowledge_base', 'data_fabric']) {
    const toggle = page.getByTestId(`source-toggle-${source}`);
    if (!(await toggle.isDisabled()) && await toggle.isChecked()) await toggle.click();
  }
  await page.getByTestId('search-input').fill(process.env.UNIFIED_SEARCH_SMOKE_EMAIL_QUERY || 'readiness');
  await page.getByTestId('search-submit').click();
  try {
    await page.waitForSelector('[data-testid="result-row"]', { timeout: 30000 });
  } catch (error) {
    const pageText = await page.locator('body').textContent();
    throw new Error(`UI search produced no result rows. Brand=${JSON.stringify(brandText)} Events=${JSON.stringify(browserEvents)} Text=${JSON.stringify(pageText?.slice(0, 2000))}`);
  }
  const resultCount = await page.locator('[data-testid="result-row"]').count();
  assert(resultCount > 0, 'expected at least one federated email result in UI');

  await page.getByTestId('result-expand').first().click();
  await page.getByTestId('assistant-prompt').fill('Summarize the selected email readiness result.');
  await page.getByTestId('assistant-summarize').click();
  await expectText(page, '.assistant-jobs', 'completed', 30000);

  console.log(JSON.stringify({
    frontend,
    browser: executablePath,
    checks: [
      'token entry authenticated connector loading',
      'email federated vector badge visible',
      'local-index connector badges visible',
      'blocked Slack/GDrive authentication requirements visible and disabled',
      'email-only UI search returned results',
      'result expansion clicked',
      'assistant summarize action completed',
    ],
    resultCount,
  }, null, 2));
} finally {
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
