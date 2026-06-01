import { google } from 'googleapis';
import { createServer } from 'node:http';

const clientId = process.env.GOOGLE_CLIENT_ID || '';
const clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://127.0.0.1:53682/oauth2callback';
const authCode = process.env.GOOGLE_AUTH_CODE || '';
const printSecret = truthy(process.env.GOOGLE_OAUTH_PRINT_SECRET);
const waitForCallback = truthy(process.env.GOOGLE_OAUTH_WAIT_FOR_CALLBACK);
const scopes = list(process.env.GOOGLE_OAUTH_SCOPES) || ['https://www.googleapis.com/auth/drive.readonly'];

if (!clientId || !clientSecret) {
  console.error(JSON.stringify({
    ok: false,
    error: 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required.',
  }, null, 2));
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

if (!authCode) {
  const authorizationUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes,
  });
  if (waitForCallback) {
    const callbackCode = await waitForOAuthCallback({ redirectUri, authorizationUrl, scopes });
    await exchangeAndPrint(oauth2Client, callbackCode, scopes, printSecret);
    process.exit(0);
  }
  console.log(JSON.stringify({
    ok: true,
    mode: 'authorization_url',
    redirectUri,
    scopes,
    authorizationUrl,
    nextStep: 'Add redirectUri to the Google OAuth client, open authorizationUrl, approve Drive access, then rerun with GOOGLE_AUTH_CODE set to the code from the redirect URL.',
    localCallbackMode: 'Set GOOGLE_OAUTH_WAIT_FOR_CALLBACK=true when running on the same machine/browser that can receive the localhost redirect.',
  }, null, 2));
  process.exit(0);
}

await exchangeAndPrint(oauth2Client, authCode, scopes, printSecret);

function list(value) {
  const items = String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
  return items.length ? items : null;
}

function truthy(value) {
  return ['1', 'true', 'yes'].includes(String(value || '').toLowerCase());
}

async function exchangeAndPrint(client, code, activeScopes, shouldPrintSecret) {
  const { tokens } = await client.getToken(code);
  const refreshToken = tokens.refresh_token || '';
  console.log(JSON.stringify({
    ok: Boolean(refreshToken),
    mode: 'token_exchange',
    scopes: activeScopes,
    hasRefreshToken: Boolean(refreshToken),
    refreshToken: shouldPrintSecret ? refreshToken : (refreshToken ? '[REDACTED_SET_GOOGLE_OAUTH_PRINT_SECRET_TRUE_TO_DISPLAY]' : ''),
    accessTokenPresent: Boolean(tokens.access_token),
    expiryDate: tokens.expiry_date || null,
    nextSteps: refreshToken ? [
      'Export GOOGLE_REFRESH_TOKEN from this response. Use GOOGLE_OAUTH_PRINT_SECRET=true only on a trusted terminal.',
      'Run VALIDATE_CONNECTOR_SOURCES=google_drive VALIDATE_CONNECTOR_REQUIRE_CONFIG=true npm run validate:connector-credentials.',
      'Run npm run gdrive:create-watch after setting GDRIVE_WEBHOOK_TOKEN and tenant/user mapping.',
    ] : [
      'No refresh token was returned. Revoke the app grant or rerun with prompt=consent/access_type=offline, then try again.',
    ],
  }, null, 2));
  process.exit(refreshToken ? 0 : 1);
}

async function waitForOAuthCallback({ redirectUri: callbackUri, authorizationUrl, scopes: activeScopes }) {
  const url = new URL(callbackUri);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error(`GOOGLE_OAUTH_WAIT_FOR_CALLBACK requires a localhost redirect URI, got ${callbackUri}`);
  }
  const port = Number(url.port || 80);
  const path = url.pathname || '/';
  console.error(JSON.stringify({
    ok: true,
    mode: 'waiting_for_callback',
    redirectUri: callbackUri,
    scopes: activeScopes,
    authorizationUrl,
    nextStep: 'Open authorizationUrl in a browser on this same machine. This process will exchange the callback code automatically.',
  }, null, 2));
  return await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        const requestUrl = new URL(req.url || '/', callbackUri);
        if (requestUrl.pathname !== path) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
          return;
        }
        const error = requestUrl.searchParams.get('error');
        if (error) throw new Error(`Google OAuth returned ${error}`);
        const code = requestUrl.searchParams.get('code');
        if (!code) throw new Error('Google OAuth callback did not include a code');
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Atlas Unified Search Google Drive authorization received. You can close this window.');
        server.close(() => resolve(code));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end(error.message);
        server.close(() => reject(error));
      }
    });
    server.on('error', reject);
    server.listen(port, url.hostname);
  });
}
