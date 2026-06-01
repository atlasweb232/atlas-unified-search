import { google } from 'googleapis';

const clientId = process.env.GOOGLE_CLIENT_ID || '';
const clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'urn:ietf:wg:oauth:2.0:oob';
const authCode = process.env.GOOGLE_AUTH_CODE || '';
const printSecret = truthy(process.env.GOOGLE_OAUTH_PRINT_SECRET);
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
  console.log(JSON.stringify({
    ok: true,
    mode: 'authorization_url',
    redirectUri,
    scopes,
    authorizationUrl,
    nextStep: 'Open authorizationUrl, approve Drive access, then rerun with GOOGLE_AUTH_CODE set to the returned code.',
  }, null, 2));
  process.exit(0);
}

const { tokens } = await oauth2Client.getToken(authCode);
const refreshToken = tokens.refresh_token || '';
console.log(JSON.stringify({
  ok: Boolean(refreshToken),
  mode: 'token_exchange',
  scopes,
  hasRefreshToken: Boolean(refreshToken),
  refreshToken: printSecret ? refreshToken : (refreshToken ? '[REDACTED_SET_GOOGLE_OAUTH_PRINT_SECRET_TRUE_TO_DISPLAY]' : ''),
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

function list(value) {
  const items = String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
  return items.length ? items : null;
}

function truthy(value) {
  return ['1', 'true', 'yes'].includes(String(value || '').toLowerCase());
}
