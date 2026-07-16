import cors from 'cors';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BlobServiceClient } from '@azure/storage-blob';
import { AssistantActionService } from './assistant/actions.js';
import { LocalArtifactProvider } from './assistant/artifacts.js';
import { createChatProvider } from './assistant/providers.js';
import { createConnectorRegistry } from './connectors/index.js';
import { createEmbedder } from './embedding.js';
import { JobRunner } from './jobRunner.js';
import { requireApiAuth } from './middleware/auth.js';
import { resolveIdentity, enforceTenantScope, deriveScope, scopeOf, allowedSourcesOf, mintIdentityToken } from './middleware/identity.js';
import { OnboardingStore } from './onboardingStore.js';
import { buildAuthorizeUrl, exchangeCode, discoverChannels, signState, verifyState, isStubMode } from './oauth/slack.js';
import { buildAuthorizeUrl as gdriveAuthorizeUrl, exchangeCode as gdriveExchangeCode, signState as gdriveSignState, verifyState as gdriveVerifyState, isStubMode as gdriveStubMode } from './oauth/gdrive.js';
import { createJobQueue } from './queue/serviceBusQueue.js';
import { parseSyncSchedules, summarizeSchedules } from './scheduleConfig.js';
import { SearchRunCoordinator } from './searchRun.js';
import { createSearchStore } from './stores/postgresStore.js';
import { SearchEngine } from './store.js';
import { createChunks, createDocument, oneLine, SOURCES } from './model.js';

export async function createApp(config) {
  const app = express();
  app.use(cors(corsOptions(config)));
  app.use(express.json({
    limit: '4mb',
    verify: (req, _res, buffer) => {
      req.rawBody = buffer.toString('utf8');
    },
  }));
  app.use(requireApiAuth(config));
  app.use(resolveIdentity(config));
  app.use(enforceTenantScope());

  const store = await createSearchStore(config);
  await store.load();
  const onboarding = new OnboardingStore({ dataDir: config.dataDir });
  await onboarding.load();
  const embedder = await createEmbedder(config);
  const searchEngine = new SearchEngine({ store, embedder, weights: config.search, embeddingDim: config.embeddingDim });
  const registry = createConnectorRegistry(config, {
    credentialResolver: (source, scope) => onboarding.credentialsFor(source, scope),
  });
  const queue = createJobQueue(config);
  const jobs = new JobRunner({ registry, store, searchEngine, queue, retry: config.syncRetry });
  const searchRuns = new SearchRunCoordinator({ store, searchEngine, registry, sourceTimeoutMs: config.searchRun?.sourceTimeoutMs });
  const assistant = new AssistantActionService({
    store,
    chatProvider: createChatProvider(config),
    artifactProvider: new LocalArtifactProvider({ dataDir: config.dataDir, azure: config.artifacts || {} }),
  });

  app.locals.services = { store, searchEngine, registry, jobs, searchRuns, assistant, queue, onboarding };

  app.get('/v1/health', (req, res) => {
    refreshStore(store).then(() => {
    res.json({
      success: true,
      service: 'atlas-unified-search',
      embedding: { model: embedder.model, version: embedder.version },
      index: publicIndexStatus(store.status()),
      auth: { required: Boolean(config.auth?.required) },
      identity: identityStatus(config),
      onboarding: onboardingStatus(config),
      cors: corsStatus(config),
      queue: { backend: queue.name },
      schedules: scheduleStatus(config),
      artifacts: { backend: assistant.artifactProvider.name, configured: assistant.artifactProvider.configured() },
      retention: retentionStatus(config),
    });
    }).catch((error) => res.status(503).json({ success: false, error: error.message }));
  });

  app.get('/v1/connectors', (req, res) => {
    res.json({ success: true, connectors: registry.list(scopeFromRequest(req)) });
  });

  app.get('/v1/connectors/readiness', async (req, res) => {
    try {
      const checks = await registry.readiness(req.query.source || '', scopeFromRequest(req));
      res.json({ success: true, checks });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  app.get('/v1/connectors/setup', async (req, res) => {
    try {
      const checks = await registry.readiness(req.query.source || '', scopeFromRequest(req));
      res.json({ success: true, setup: connectorSetupGuide(checks) });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // ─── token refresh (session renewal without re-login) ──────────────────────
  // Exempt from identity binding; verifies the existing token internally.
  app.post('/v1/auth/refresh', async (req, res) => {
    const secret = config.identity?.jwtSecret;
    if (!secret) return res.status(400).json({ success: false, error: 'IDENTITY_JWT_SECRET not configured' });
    const header = String(req.headers.authorization || '');
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    if (!token) return res.status(401).json({ success: false, error: 'Missing bearer token' });
    try {
      const { verifyJwtHS256Internal } = await import('./middleware/identity.js');
      const claims = verifyJwtHS256Internal(token, secret);
      const minted = mintIdentityToken({
        tenantId: claims.tenantId || claims.tid,
        userId: claims.userId || claims.sub,
        sources: claims.sources,
        ttlSeconds: config.onboarding?.tokenTtlSeconds,
        issuer: config.identity?.jwtIssuer,
        audience: config.identity?.jwtAudience,
      }, secret);
      return res.json({ success: true, token: minted.token, expiresAt: minted.expiresAt });
    } catch (error) {
      return res.status(401).json({ success: false, error: error.message });
    }
  });

  // ─── onboarding (admin-provisioned pilot) ─────────────────────────────────
  // Exempt from identity binding (cross-tenant provisioning); guarded by the
  // onboarding admin token instead.
  app.post('/v1/onboarding/tenants', async (req, res) => {
    if (!onboardingAdminOk(config, req)) return res.status(401).json({ success: false, error: 'Onboarding admin token required' });
    const { tenantId, name = '' } = req.body || {};
    if (!tenantId) return res.status(400).json({ success: false, error: 'tenantId is required' });
    try {
      const tenant = await onboarding.createTenant({ tenantId, name });
      return res.status(201).json({ success: true, tenant });
    } catch (error) {
      return res.status(400).json({ success: false, error: error.message });
    }
  });

  app.post('/v1/onboarding/users', async (req, res) => {
    if (!onboardingAdminOk(config, req)) return res.status(401).json({ success: false, error: 'Onboarding admin token required' });
    const { tenantId, userId, email = '', sources = [] } = req.body || {};
    if (!tenantId || !userId) return res.status(400).json({ success: false, error: 'tenantId and userId are required' });
    try {
      const user = await onboarding.createUser({ tenantId, userId, email, sources });
      const minted = mintIdentityToken({
        tenantId,
        userId,
        sources,
        ttlSeconds: config.onboarding?.tokenTtlSeconds,
        issuer: config.identity?.jwtIssuer,
        audience: config.identity?.jwtAudience,
      }, config.identity?.jwtSecret);
      return res.status(201).json({ success: true, user, token: minted.token, expiresAt: minted.expiresAt });
    } catch (error) {
      return res.status(400).json({ success: false, error: error.message });
    }
  });

  app.post('/v1/onboarding/connections/:source', async (req, res) => {
    if (!onboardingAdminOk(config, req)) return res.status(401).json({ success: false, error: 'Onboarding admin token required' });
    const { tenantId, userId, credentials = {} } = req.body || {};
    const source = req.params.source;
    if (!tenantId || !userId) return res.status(400).json({ success: false, error: 'tenantId and userId are required' });
    try {
      registry.get(source); // 404-style guard: only enabled sources are connectable
    } catch (error) {
      return res.status(400).json({ success: false, error: error.message });
    }
    try {
      const connection = await onboarding.connectSource({ tenantId, userId, source, credentials });
      const configured = registry.get(source).isConfigured({ tenantId, userId });
      // Auto-start the first backfill unless explicitly disabled.
      const backfill = (configured && req.body?.backfill !== false)
        ? await autoBackfill(jobs, { source, tenantId, userId })
        : { jobId: null };
      return res.status(201).json({ success: true, connection, configured, backfillJobId: backfill.jobId });
    } catch (error) {
      return res.status(400).json({ success: false, error: error.message });
    }
  });

  app.get('/v1/onboarding/tenants/:tenantId/users/:userId', async (req, res) => {
    if (!onboardingAdminOk(config, req)) return res.status(401).json({ success: false, error: 'Onboarding admin token required' });
    const { tenantId, userId } = req.params;
    const user = onboarding.getUser(tenantId, userId);
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    return res.json({ success: true, user, connections: onboarding.listConnections(tenantId, userId) });
  });

  // ─── Slack OAuth: self-serve "Sign in with Slack" → auto-connect → backfill ──
  // No admin token: authenticated by Slack. One platform-wide app; a workspace
  // maps to a tenant. STUB mode (no client id/secret) makes this testable with
  // no real Slack app — pass code `stub:<team>:<user>:<email>`.
  app.get('/v1/onboarding/oauth/slack/start', (req, res) => {
    const secret = config.identity?.jwtSecret;
    if (!secret) return res.status(400).json({ success: false, error: 'IDENTITY_JWT_SECRET is required for OAuth' });
    const state = signState({ provider: 'slack', tenantHint: req.query.tenant || '' }, secret);
    const authorizeUrl = buildAuthorizeUrl({ config, state });
    if (req.query.redirect === '1') return res.redirect(authorizeUrl);
    return res.json({ success: true, authorizeUrl, state, stub: isStubMode(config) });
  });

  app.get('/v1/onboarding/oauth/slack/callback', async (req, res) => {
    const secret = config.identity?.jwtSecret;
    try {
      verifyState(req.query.state, secret);
    } catch (error) {
      return res.status(400).json({ success: false, error: error.message });
    }
    if (req.query.error) return res.status(400).json({ success: false, error: `Slack denied: ${req.query.error}` });
    if (!req.query.code) return res.status(400).json({ success: false, error: 'Missing authorization code' });

    try {
      const result = await exchangeCode({ config, code: req.query.code });
      if (!result.teamId || !result.slackUserId) throw new Error('Slack did not return team/user identity');

      // Workspace → tenant, authed user → platform user (idempotent).
      const tenantId = `slack:${result.teamId}`;
      const userId = result.slackUserId;
      await onboarding.ensureTenant({ tenantId, name: result.teamName });
      await onboarding.ensureUser({ tenantId, userId, email: result.email, sources: ['slack'] });

      // Workspace bot token is shared tenant-wide; channels the bot can read.
      const channelIds = await discoverChannels({ config, botToken: result.botToken, stub: result.stub });
      await onboarding.connectTenantSource({
        tenantId,
        source: 'slack',
        credentials: { botToken: result.botToken, channelIds },
      });

      // Notify auth-service so it can record a source_connections row keyed to
      // this user's Atlas account (fire-and-forget; never blocks the OAuth redirect).
      notifySourceConnectCallback(config, {
        sourceId: 'slack',
        email: result.email,
        credentialRef: `${tenantId}:*:slack`,
        providerId: 'slack',
      }).catch((error) => console.error('[source-connect-callback] slack:', error.message));

      // Mint our session token and auto-start the first backfill (vectorization).
      const minted = mintIdentityToken({
        tenantId, userId, sources: ['slack'],
        ttlSeconds: config.onboarding?.tokenTtlSeconds,
        issuer: config.identity?.jwtIssuer, audience: config.identity?.jwtAudience,
      }, secret);
      const backfill = await autoBackfill(jobs, { source: 'slack', tenantId, userId });

      // Bounce back to the frontend with the token, or return JSON.
      const redirect = config.slack?.oauth?.postLoginRedirect;
      if (redirect) {
        const url = new URL(redirect);
        url.hash = new URLSearchParams({ token: minted.token, tenantId, userId }).toString();
        return res.redirect(url.toString());
      }
      return res.json({
        success: true, tenantId, userId, token: minted.token, expiresAt: minted.expiresAt,
        connected: 'slack', channels: channelIds.length, backfillJobId: backfill.jobId, stub: Boolean(result.stub),
      });
    } catch (error) {
      return res.status(400).json({ success: false, error: error.message });
    }
  });

  // ─── Google Drive OAuth: self-serve login → auto-connect → backfill ──────────
  app.get('/v1/onboarding/oauth/gdrive/start', (req, res) => {
    const secret = config.identity?.jwtSecret;
    if (!secret) return res.status(400).json({ success: false, error: 'IDENTITY_JWT_SECRET is required for OAuth' });
    const state = gdriveSignState({ provider: 'gdrive' }, secret);
    const authorizeUrl = gdriveAuthorizeUrl({ config, state });
    if (req.query.redirect === '1') return res.redirect(authorizeUrl);
    return res.json({ success: true, authorizeUrl, state, stub: gdriveStubMode(config) });
  });

  app.get('/v1/onboarding/oauth/gdrive/callback', async (req, res) => {
    const secret = config.identity?.jwtSecret;
    try { gdriveVerifyState(req.query.state, secret); } catch (error) {
      return res.status(400).json({ success: false, error: error.message });
    }
    if (req.query.error) return res.status(400).json({ success: false, error: `Google denied: ${req.query.error}` });
    if (!req.query.code) return res.status(400).json({ success: false, error: 'Missing authorization code' });
    try {
      const result = await gdriveExchangeCode({ config, code: req.query.code });
      if (!result.email) throw new Error('Google did not return user identity');

      const tenantId = `google:${result.email.split('@')[1] || 'unknown'}`;
      const userId = result.googleUserId || result.email;
      await onboarding.ensureTenant({ tenantId, name: result.email.split('@')[1] || tenantId });
      await onboarding.ensureUser({ tenantId, userId, email: result.email, sources: ['google_drive'] });
      await onboarding.connectTenantSource({
        tenantId, source: 'google_drive',
        credentials: {
          clientId: config.gdrive.clientId,
          clientSecret: config.gdrive.clientSecret,
          refreshToken: result.refreshToken,
        },
      });

      // Notify auth-service (fire-and-forget; never blocks the OAuth redirect).
      notifySourceConnectCallback(config, {
        sourceId: 'gdrive',
        email: result.email,
        credentialRef: `${tenantId}:*:google_drive`,
        providerId: 'google-workspace',
      }).catch((error) => console.error('[source-connect-callback] gdrive:', error.message));

      const minted = mintIdentityToken({
        tenantId, userId, sources: ['google_drive'],
        ttlSeconds: config.onboarding?.tokenTtlSeconds,
        issuer: config.identity?.jwtIssuer, audience: config.identity?.jwtAudience,
      }, secret);
      const backfill = await autoBackfill(jobs, { source: 'google_drive', tenantId, userId });

      const redirect = config.gdrive?.oauth?.postLoginRedirect;
      if (redirect) {
        const url = new URL(redirect);
        url.hash = new URLSearchParams({ token: minted.token, tenantId, userId }).toString();
        return res.redirect(url.toString());
      }
      return res.json({
        success: true, tenantId, userId, token: minted.token, expiresAt: minted.expiresAt,
        connected: 'google_drive', backfillJobId: backfill.jobId, stub: Boolean(result.stub),
      });
    } catch (error) {
      return res.status(400).json({ success: false, error: error.message });
    }
  });

  app.post('/v1/webhooks/slack/events', async (req, res) => {
    const signature = verifySlackSignature(config, req);
    if (!signature.ok) {
      return res.status(signature.status).json({ success: false, error: signature.error });
    }
    if (req.body?.type === 'url_verification') {
      return res.json({ challenge: req.body.challenge || '' });
    }
    const tenantId = config.slack?.eventTenantId || '';
    const userId = config.slack?.eventUserId || '';
    if (!tenantId || !userId) {
      return res.status(400).json({ success: false, error: 'SLACK_EVENT_TENANT_ID and SLACK_EVENT_USER_ID are required for Slack events' });
    }
    const event = req.body?.event || {};
    try {
      const result = await enqueueConnectorEvent({
        config,
        registry,
        store,
        jobs,
        source: 'slack',
        tenantId,
        userId,
        event: {
          ...event,
          event_id: req.body?.event_id || event.event_id,
          event_ts: req.body?.event_time ? String(req.body.event_time) : event.event_ts,
        },
        options: {},
        wait: false,
      });
      return res.status(202).json({ success: true, job: result.job, eventTrigger: result.eventTrigger });
    } catch (error) {
      return res.status(error.statusCode || 400).json({ success: false, error: error.message, details: error.details || undefined });
    }
  });

  app.post('/v1/webhooks/google-drive/changes', async (req, res) => {
    const verification = verifyGoogleDriveWebhook(config, req);
    if (!verification.ok) {
      return res.status(verification.status).json({ success: false, error: verification.error });
    }
    const tenantId = config.gdrive?.eventTenantId || '';
    const userId = config.gdrive?.eventUserId || '';
    if (!tenantId || !userId) {
      return res.status(400).json({ success: false, error: 'GDRIVE_EVENT_TENANT_ID and GDRIVE_EVENT_USER_ID are required for Google Drive changes' });
    }
    const event = {
      type: 'google_drive.change',
      event_id: req.headers['x-goog-message-number'] || '',
      resourceId: req.headers['x-goog-resource-id'] || '',
      resourceState: req.headers['x-goog-resource-state'] || '',
      channelId: req.headers['x-goog-channel-id'] || '',
      changed: req.headers['x-goog-changed'] || '',
    };
    try {
      const result = await enqueueConnectorEvent({
        config,
        registry,
        store,
        jobs,
        source: 'google_drive',
        tenantId,
        userId,
        event,
        options: {},
        wait: false,
      });
      return res.status(202).json({ success: true, job: result.job, eventTrigger: result.eventTrigger });
    } catch (error) {
      return res.status(error.statusCode || 400).json({ success: false, error: error.message, details: error.details || undefined });
    }
  });

  app.post('/v1/webhooks/azure-blob/events', async (req, res) => {
    const verification = verifyAzureBlobWebhook(config, req);
    if (!verification.ok) {
      return res.status(verification.status).json({ success: false, error: verification.error });
    }
    const events = Array.isArray(req.body) ? req.body : [req.body].filter(Boolean);
    const validationEvent = events.find((event) => event?.eventType === 'Microsoft.EventGrid.SubscriptionValidationEvent');
    if (validationEvent) {
      return res.json({ validationResponse: validationEvent.data?.validationCode || '' });
    }
    const tenantId = config.conference?.eventTenantId || '';
    const userId = config.conference?.eventUserId || '';
    if (!tenantId || !userId) {
      return res.status(400).json({ success: false, error: 'CONFERENCE_EVENT_TENANT_ID and CONFERENCE_EVENT_USER_ID are required for Azure Blob events' });
    }
    const accepted = [];
    try {
      for (const event of events.filter((item) => item?.eventType === 'Microsoft.Storage.BlobCreated')) {
        const blob = parseBlobEventSubject(event.subject || event.data?.url || '');
        if (!blob.container || !blob.blobName) continue;
        if (config.conference?.containers?.length && !config.conference.containers.includes(blob.container)) {
          const error = new Error(`Conference blob container is not enabled: ${blob.container}`);
          error.statusCode = 403;
          throw error;
        }
        const result = await enqueueConnectorEvent({
          config,
          registry,
          store,
          jobs,
          source: 'conference_bridge',
          tenantId,
          userId,
          event: {
            type: event.eventType,
            event_id: event.id || '',
            prefix: blob.blobName,
            blobPrefix: blob.blobName,
            container: blob.container,
            resourceId: event.topic || '',
          },
          options: {},
          wait: false,
        });
        accepted.push({ job: result.job, eventTrigger: result.eventTrigger });
      }
      if (!accepted.length) {
        return res.status(202).json({ success: true, accepted: 0, skipped: events.length });
      }
      return res.status(202).json({ success: true, accepted: accepted.length, results: accepted });
    } catch (error) {
      return res.status(error.statusCode || 400).json({ success: false, error: error.message, details: error.details || undefined });
    }
  });

  app.get('/v1/production-readiness', async (req, res) => {
    try {
      await refreshStore(store);
      const connectorChecks = await registry.readiness();
      const report = productionReadinessReport({
        config,
        store,
        queue,
        assistant,
        connectorChecks,
      });
      res.status(report.readyForProductionTesting ? 200 : 503).json({ success: true, report });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/v1/data-fabric/health', async (_req, res) => {
    try {
      await refreshStore(store);
      res.json({
        success: true,
        ready: true,
        service: 'atlas-unified-search-data-fabric',
        version: '1',
        datasets: ['index_status', 'audit_events', 'operational_summary'],
      });
    } catch (error) {
      res.status(503).json({ success: false, ready: false, error: error.message });
    }
  });

  app.get('/v1/data-fabric/records', async (req, res) => {
    const { tenantId, userId, dataset = 'operational_summary', limit = '50' } = req.query || {};
    if (!tenantId || !userId) {
      return res.status(400).json({ success: false, error: 'tenantId and userId are required' });
    }
    try {
      await refreshStore(store);
      const records = dataFabricRecords({
        store,
        tenantId,
        userId,
        dataset,
        limit: Math.min(Math.max(Number(limit) || 50, 1), 200),
      });
      return res.json({ success: true, records });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/v1/index/status', async (req, res) => {
    const { tenantId, userId } = req.query || {};
    if (!tenantId || !userId) {
      return res.status(400).json({ success: false, error: 'tenantId and userId are required' });
    }
    await refreshStore(store);
    return res.json({ success: true, index: store.scopedStatus({ tenantId, userId }) });
  });

  app.post('/v1/sync/:source', async (req, res) => {
    const { tenantId, userId, options = {}, wait = false } = req.body || {};
    if (!tenantId || !userId) {
      return res.status(400).json({ success: false, error: 'tenantId and userId are required' });
    }
    if (!sourceAllowed(config, tenantId, userId, req.params.source)) {
      return res.status(403).json({ success: false, error: `Source is not enabled for this user: ${req.params.source}` });
    }
    try {
      await requireReadyConnector(registry, req.params.source, options, { tenantId, userId });
      const job = await jobs.enqueue({ source: req.params.source, tenantId, userId, options, autoStart: !wait });
      if (wait) {
        const result = await jobs.run(job.id, { source: req.params.source, tenantId, userId, options });
        return res.json({ success: true, job: result.job, indexed: result.indexed });
      }
      return res.status(202).json({ success: true, job });
    } catch (error) {
      return res.status(400).json({ success: false, error: error.message });
    }
  });

  app.post('/v1/events/:source', async (req, res) => {
    const { tenantId, userId, event = {}, options = {}, wait = false } = req.body || {};
    if (!tenantId || !userId) {
      return res.status(400).json({ success: false, error: 'tenantId and userId are required' });
    }
    try {
      const result = await enqueueConnectorEvent({
        config,
        registry,
        store,
        jobs,
        source: req.params.source,
        tenantId,
        userId,
        event,
        options,
        wait,
      });
      return res.status(wait ? 200 : 202).json({ success: true, ...result });
    } catch (error) {
      return res.status(error.statusCode || 400).json({ success: false, error: error.message, details: error.details || undefined });
    }
  });

  app.post('/v1/meeting/archive', async (req, res) => {
    return handleMeetingArchiveOperation({ req, res, config, store, searchEngine, operation: 'archive' });
  });

  app.post('/v1/meeting/ingest', async (req, res) => {
    return handleMeetingArchiveOperation({ req, res, config, store, searchEngine, operation: 'ingest' });
  });

  app.post('/v1/meeting/recording/upload', async (req, res) => {
    const request = req.body || {};
    const scope = deriveScope(req, res, {
      tenantId: request.tenantId || request.TenantId || '',
      userId: request.userId || request.UserId || req.headers['x-user-id'] || unboundOwnerEmail(req, request),
    });
    if (!scope) return undefined;
    const { tenantId, userId } = scope;
    if (!tenantId || !userId) {
      return res.status(400).json({ success: false, error: 'tenantId and userId are required' });
    }
    if (!meetingSourceAllowed({ req, config, tenantId, userId })) {
      return res.status(403).json({ success: false, error: 'Source is not enabled for this user: conference_bridge' });
    }

    const meetingId = stringField(request, 'meetingId', 'MeetingId');
    const requestId = stringField(request, 'requestId', 'RequestId') || meetingId;
    if (!meetingId || !requestId) {
      return res.status(400).json({ success: false, error: 'meetingId and requestId are required' });
    }

    try {
      await refreshStore(store);
      const recordingId = stableId('recording', tenantId, userId, meetingId, requestId);
      const storage = meetingRecordingStorage(config, recordingId, recordingExtension(request));
      const uploadUrl = absoluteUrl(req, `/v1/meeting/recording/blob/${encodeURIComponent(recordingId)}?tenantId=${encodeURIComponent(tenantId)}&userId=${encodeURIComponent(userId)}`);
      const contentType = stringField(request, 'contentType', 'ContentType') || 'application/octet-stream';
      const artifact = store.upsertArtifact({
        id: recordingId,
        tenantId,
        userId,
        type: 'meeting_recording_upload',
        status: 'upload_requested',
        meetingId,
        requestId,
        recordingUri: storage.recordingUri,
        storageBackend: storage.backend,
        objectPath: storage.objectPath,
        blobName: storage.blobName,
        contentType,
        expectedSizeBytes: numberField(request, 'sizeBytes', 'SizeBytes'),
        checksumSha256: stringField(request, 'checksumSha256', 'ChecksumSha256'),
        metadata: request.metadata || request.Metadata || {},
      });
      store.audit({
        eventType: 'meeting_recording_upload_requested',
        tenantId,
        userId,
        source: SOURCES.conference,
        metadata: { meetingId, requestId, recordingId },
      });
      await store.save();
      return res.status(201).json({
        success: true,
        ok: true,
        recordingId,
        uploadId: recordingId,
        uploadUrl,
        recordingUri: storage.recordingUri,
        objectUri: storage.recordingUri,
        headers: { 'content-type': contentType },
        expiresAtUtc: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        status: artifact.status,
      });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  app.put('/v1/meeting/recording/blob/:recordingId', express.raw({ type: '*/*', limit: '512mb' }), async (req, res) => {
    const recordingId = req.params.recordingId;
    try {
      await refreshStore(store);
      const artifact = store.getArtifact(recordingId);
      if (!artifact) return res.status(404).json({ success: false, error: 'Recording upload session not found' });
      if (!matchesScope(req, artifact)) return res.status(403).json({ success: false, error: 'Forbidden' });
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
      if (!bytes.length) return res.status(400).json({ success: false, error: 'Recording upload body is required' });
      await storeMeetingRecordingBytes({ config, artifact, bytes });
      store.upsertArtifact({
        ...artifact,
        status: 'uploaded',
        uploadedBytes: bytes.length,
        uploadedChecksumSha256: sha256(bytes),
        uploadedAtUtc: new Date().toISOString(),
      });
      store.audit({
        eventType: 'meeting_recording_uploaded',
        tenantId: artifact.tenantId,
        userId: artifact.userId,
        source: SOURCES.conference,
        metadata: { meetingId: artifact.meetingId, requestId: artifact.requestId, recordingId },
      });
      await store.save();
      return res.json({ success: true, ok: true, recordingId, status: 'uploaded' });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/v1/meeting/recording/complete', async (req, res) => {
    const request = req.body || {};
    const recordingId = stringField(request, 'recordingId', 'RecordingId');
    const scope = deriveScope(req, res, {
      tenantId: request.tenantId || request.TenantId || '',
      userId: request.userId || request.UserId || req.headers['x-user-id'] || unboundOwnerEmail(req, request),
    });
    if (!scope) return undefined;
    if (!recordingId) return res.status(400).json({ success: false, error: 'recordingId is required' });
    try {
      await refreshStore(store);
      const artifact = store.getArtifact(recordingId);
      if (!artifact) return res.status(404).json({ success: false, error: 'Recording upload session not found' });
      if (artifact.tenantId !== scope.tenantId || artifact.userId !== scope.userId) {
        return res.status(403).json({ success: false, error: 'Forbidden' });
      }
      if (artifact.status !== 'uploaded' && artifact.status !== 'accepted') {
        return res.status(409).json({ success: false, error: 'Recording bytes have not been uploaded.' });
      }
      const requestedSize = numberField(request, 'sizeBytes', 'SizeBytes');
      if (requestedSize && artifact.uploadedBytes && requestedSize !== artifact.uploadedBytes) {
        return res.status(409).json({ success: false, error: 'Recording upload size does not match completed size.' });
      }
      const requestedChecksum = stringField(request, 'checksumSha256', 'ChecksumSha256');
      if (requestedChecksum && artifact.uploadedChecksumSha256 && requestedChecksum !== artifact.uploadedChecksumSha256) {
        return res.status(409).json({ success: false, error: 'Recording upload checksum does not match completed checksum.' });
      }
      const receipt = operationReceipt('recording', recordingId);
      store.upsertArtifact({
        ...artifact,
        status: 'accepted',
        completedAtUtc: receipt.acceptedAtUtc,
        completedSizeBytes: numberField(request, 'sizeBytes', 'SizeBytes') || artifact.uploadedBytes || 0,
        completedChecksumSha256: stringField(request, 'checksumSha256', 'ChecksumSha256') || artifact.checksumSha256 || '',
        receipt,
      });
      store.audit({
        eventType: 'meeting_recording_completed',
        tenantId: scope.tenantId,
        userId: scope.userId,
        source: SOURCES.conference,
        metadata: { meetingId: artifact.meetingId, requestId: artifact.requestId, recordingId },
      });
      await store.save();
      return res.json({
        success: true,
        ok: true,
        recordingId,
        receiptId: receipt.receiptId,
        status: receipt.status,
        message: receipt.message,
        acceptedAtUtc: receipt.acceptedAtUtc,
      });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/v1/search', async (req, res) => {
    const { tenantId: bodyTenant, userId: bodyUser, query, sources, filters, limit } = req.body || {};
    const scope = deriveScope(req, res, { tenantId: bodyTenant, userId: bodyUser });
    if (!scope) return undefined;
    const { tenantId, userId } = scope;
    if (!tenantId || !userId || !query) {
      return res.status(400).json({ success: false, error: 'tenantId, userId, and query are required' });
    }
    try {
      await refreshStore(store);
      const requestedSources = intersectAllowed(sources, allowedSourcesOf(req));
      const allowedSources = filterAllowedSources(config, tenantId, userId, requestedSources);
      if (hasSourcePermissions(config) && !allowedSources.length) {
        return res.status(403).json({ success: false, error: 'No sources are enabled for this user' });
      }
      const results = await searchEngine.search({ tenantId, userId, query, sources: allowedSources, filters, limit });
      store.audit({ eventType: 'search', tenantId, userId, queryHash: hashQuery(query), metadata: { sources, resultCount: results.length } });
      await store.save();
      return res.json({ success: true, query, results });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/v1/search-runs', async (req, res) => {
    const { tenantId, userId, query, sources, filters, limit, wait = false } = req.body || {};
    if (!tenantId || !userId || !query) {
      return res.status(400).json({ success: false, error: 'tenantId, userId, and query are required' });
    }
    try {
      await refreshStore(store);
      const allowedSources = filterAllowedSources(config, tenantId, userId, sources);
      if (hasSourcePermissions(config) && !allowedSources.length) {
        return res.status(403).json({ success: false, error: 'No sources are enabled for this user' });
      }
      const searchRun = await searchRuns.start({ tenantId, userId, query, sources: allowedSources, filters, limit, wait });
      return res.status(wait ? 200 : 202).json({ success: true, searchRun, results: searchRun.results || [] });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/v1/search-runs/:searchRunId/events', async (req, res) => {
    const tenantId = req.query.tenantId || req.headers['x-tenant-id'];
    const userId = req.query.userId || req.headers['x-user-id'];
    if (!tenantId || !userId) {
      return res.status(400).json({ success: false, error: 'tenantId and userId are required' });
    }
    await refreshStore(store);
    const initialRun = store.getSearchRun(req.params.searchRunId);
    if (!initialRun) return res.status(404).json({ success: false, error: 'Search run not found' });
    if (!matchesScope(req, initialRun)) return res.status(403).json({ success: false, error: 'Forbidden' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    let lastUpdatedAt = '';
    let closed = false;
    const close = () => {
      closed = true;
      clearInterval(interval);
      clearTimeout(timeout);
      res.end();
    };
    const sendSnapshot = async ({ force = false } = {}) => {
      if (closed || res.destroyed) return;
      await refreshStore(store);
      const run = store.getSearchRun(req.params.searchRunId);
      if (!run || run.tenantId !== tenantId || run.userId !== userId) {
        writeSse(res, 'error', { error: 'Search run is no longer available' });
        close();
        return;
      }
      if (force || run.updatedAt !== lastUpdatedAt) {
        lastUpdatedAt = run.updatedAt;
        writeSse(res, 'snapshot', { searchRun: run, results: run.results || [] });
      }
      if (isTerminalSearchRun(run)) {
        writeSse(res, 'done', { searchRun: run, results: run.results || [] });
        close();
      }
    };
    const interval = setInterval(() => {
      sendSnapshot().catch((error) => {
        writeSse(res, 'error', { error: error.message });
        close();
      });
    }, 500);
    const timeout = setTimeout(() => {
      writeSse(res, 'timeout', { error: 'Search run event stream timed out' });
      close();
    }, config.searchRun?.streamTtlMs || 300000);
    req.on('close', close);
    sendSnapshot({ force: true }).catch((error) => {
      writeSse(res, 'error', { error: error.message });
      close();
    });
  });

  app.get('/v1/search-runs/:searchRunId', async (req, res) => {
    await refreshStore(store);
    const searchRun = store.getSearchRun(req.params.searchRunId);
    if (!searchRun) return res.status(404).json({ success: false, error: 'Search run not found' });
    if (!matchesScope(req, searchRun)) return res.status(403).json({ success: false, error: 'Forbidden' });
    return res.json({ success: true, searchRun, results: searchRun.results || [] });
  });

  app.get('/v1/documents/:documentId', async (req, res) => {
    await refreshStore(store);
    const document = store.getDocument(req.params.documentId);
    if (!document) return res.status(404).json({ success: false, error: 'Document not found' });
    if (!matchesScope(req, document)) return res.status(403).json({ success: false, error: 'Forbidden' });
    return res.json({ success: true, document });
  });

  app.delete('/v1/documents', async (req, res) => {
    const tenantId = req.body?.tenantId || req.query.tenantId;
    const userId = req.body?.userId || req.query.userId;
    const source = req.body?.source || req.query.source || '';
    const documentIds = req.body?.documentIds || [];
    const resetCheckpoints = Boolean(req.body?.resetCheckpoints || req.query.resetCheckpoints === 'true');
    return deleteScopedDocuments({ req, res, config, store, tenantId, userId, source, documentIds, resetCheckpoints });
  });

  app.delete('/v1/sources/:source/documents', async (req, res) => {
    const tenantId = req.body?.tenantId || req.query.tenantId;
    const userId = req.body?.userId || req.query.userId;
    const documentIds = req.body?.documentIds || [];
    const resetCheckpoints = Boolean(req.body?.resetCheckpoints || req.query.resetCheckpoints === 'true');
    return deleteScopedDocuments({ req, res, config, store, tenantId, userId, source: req.params.source, documentIds, resetCheckpoints });
  });

  app.post('/v1/retention/cleanup', async (req, res) => {
    const { tenantId, userId, dryRun = true } = req.body || {};
    if (!tenantId || !userId) {
      return res.status(400).json({ success: false, error: 'tenantId and userId are required' });
    }
    try {
      await refreshStore(store);
      const report = await store.cleanupRetention({
        tenantId,
        userId,
        documentRetentionDays: req.body?.documentRetentionDays || config.retention?.documentDays,
        operationalRetentionDays: req.body?.operationalRetentionDays || config.retention?.operationalDays,
        auditRetentionDays: req.body?.auditRetentionDays || config.retention?.auditDays,
        dryRun,
      });
      store.audit({
        eventType: dryRun ? 'retention_cleanup_dry_run' : 'retention_cleanup',
        tenantId,
        userId,
        metadata: { deleted: report.deleted, cutoffs: report.cutoffs },
      });
      await store.save();
      return res.json({ success: true, report });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/v1/reindex/:source', async (req, res) => {
    const { tenantId, userId, options = {}, wait = false } = req.body || {};
    if (!tenantId || !userId) {
      return res.status(400).json({ success: false, error: 'tenantId and userId are required' });
    }
    if (!sourceAllowed(config, tenantId, userId, req.params.source)) {
      return res.status(403).json({ success: false, error: `Source is not enabled for this user: ${req.params.source}` });
    }
    try {
      await requireReadyConnector(registry, req.params.source, options, { tenantId, userId });
      await refreshStore(store);
      const deleted = store.deleteDocuments({ tenantId, userId, source: req.params.source });
      const checkpoints = store.deleteCheckpoints({ tenantId, userId, source: req.params.source });
      store.audit({ eventType: 'reindex_start', tenantId, userId, source: req.params.source, metadata: { deleted: deleted.deleted, checkpointDeleted: checkpoints.deleted } });
      await store.save();
      const job = await jobs.enqueue({
        source: req.params.source,
        tenantId,
        userId,
        options: { ...options, forceFullSync: true },
        autoStart: !wait,
      });
      if (wait) {
        const result = await jobs.run(job.id, { source: req.params.source, tenantId, userId, options: { ...options, forceFullSync: true } });
        return res.json({ success: true, deleted: deleted.deleted, checkpointDeleted: checkpoints.deleted, job: result.job, indexed: result.indexed });
      }
      return res.status(202).json({ success: true, deleted: deleted.deleted, checkpointDeleted: checkpoints.deleted, job });
    } catch (error) {
      return res.status(error.statusCode || 400).json({ success: false, error: error.message, details: error.details || undefined });
    }
  });

  app.get('/v1/jobs', async (req, res) => {
    const { tenantId, userId } = req.query || {};
    if (!tenantId || !userId) {
      return res.status(400).json({ success: false, error: 'tenantId and userId are required' });
    }
    await refreshStore(store);
    res.json({ success: true, jobs: jobs.listJobs({ tenantId, userId }) });
  });

  app.get('/v1/audit', async (req, res) => {
    const { tenantId, userId, eventType = '', limit = '100' } = req.query || {};
    if (!tenantId || !userId) {
      return res.status(400).json({ success: false, error: 'tenantId and userId are required' });
    }
    await refreshStore(store);
    const events = store.listAudit({ tenantId, userId, eventType, limit });
    return res.json({ success: true, events });
  });

  app.post('/v1/assistant/actions', async (req, res) => {
    const { tenantId, userId, searchRunId, actionType, selectedResultIds, prompt, provider } = req.body || {};
    if (!tenantId || !userId || !searchRunId || !actionType || !selectedResultIds?.length) {
      return res.status(400).json({ success: false, error: 'tenantId, userId, searchRunId, actionType, and selectedResultIds are required' });
    }
    try {
      await refreshStore(store);
      const actionJob = await assistant.run({ tenantId, userId, searchRunId, actionType, selectedResultIds, prompt, provider });
      return res.status(actionJob.status === 'failed' ? 500 : 202).json({ success: actionJob.status !== 'failed', actionJob });
    } catch (error) {
      return res.status(400).json({ success: false, error: error.message });
    }
  });

  app.get('/v1/assistant/actions/:actionJobId', async (req, res) => {
    await refreshStore(store);
    const actionJob = store.getAssistantAction(req.params.actionJobId);
    if (!actionJob) return res.status(404).json({ success: false, error: 'Assistant action not found' });
    if (!matchesScope(req, actionJob)) return res.status(403).json({ success: false, error: 'Forbidden' });
    return res.json({ success: true, actionJob });
  });

  // ─── Internal credential resolver (called by atlas-source-provider-gateway) ───
  // Guards itself with its own token; bypasses global auth since path is /internal/.
  app.post('/internal/credentials/resolve', async (req, res) => {
    const resolverToken = config.sourceLifecycle?.credentialResolverToken || '';
    if (!resolverToken) {
      return res.status(503).json({ success: false, code: 'RESOLVER_NOT_CONFIGURED', error: 'Credential resolver is not configured' });
    }
    const presented = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (!constantTimeEquals(presented, resolverToken)) {
      return res.status(401).json({ success: false, code: 'UNAUTHORIZED', error: 'Unauthorized' });
    }
    const body = req.body || {};
    const credentialRef = String(body.credential_ref || '').trim();
    const tenantId = String(body.tenant_id || '').trim();
    const userId = String(body.user_id || '').trim();
    const sourceId = String(body.source_id || '').trim();
    const providerId = String(body.provider_id || '').trim();
    if (!credentialRef || !tenantId || !userId || !sourceId || !providerId) {
      return res.status(400).json({ success: false, code: 'MISSING_FIELDS', error: 'credential_ref, tenant_id, user_id, source_id, provider_id are required' });
    }
    // credential_ref format: "${unifiedTenantId}:${unifiedUserId}:${source}"
    // unifiedTenantId may contain colons (e.g. "slack:T123", "google:example.com")
    // Use "*" as unifiedUserId for tenant-wide credentials.
    const parts = credentialRef.split(':');
    if (parts.length < 3) {
      return res.status(400).json({ success: false, code: 'INVALID_CREDENTIAL_REF', error: 'Invalid credential_ref' });
    }
    const refSource = parts[parts.length - 1];
    const refUserId = parts[parts.length - 2];
    const refTenantId = parts.slice(0, parts.length - 2).join(':');
    const credentials = onboarding.credentialsFor(refSource, { tenantId: refTenantId, userId: refUserId });
    if (!credentials || Object.keys(credentials).length === 0) {
      return res.status(404).json({ success: false, code: 'CREDENTIAL_NOT_FOUND', error: 'Credential not found' });
    }
    // Return input binding fields verbatim — source gateway validates these match
    // what auth-service recorded in source_connections.
    return res.json({
      success: true,
      credential: {
        tenant_id: tenantId,
        user_id: userId,
        source_id: sourceId,
        provider_id: providerId,
        access_token: credentials.botToken || credentials.accessToken || credentials.access_token || '',
        refresh_token: credentials.refreshToken || credentials.refresh_token || '',
      },
    });
  });

  const frontendDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../frontend/dist');
  app.use(express.static(frontendDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/v1/')) return next();
    res.sendFile(path.join(frontendDist, 'index.html'), (error) => {
      if (error) next();
    });
  });

  return app;
}

async function handleMeetingArchiveOperation({ req, res, config, store, searchEngine, operation }) {
  const envelope = req.body || {};
  const archive = envelope.archive || envelope.Archive || envelope;
  const scope = deriveScope(req, res, {
    tenantId: archive.tenantId || archive.TenantId || envelope.tenantId || envelope.TenantId || req.headers['x-tenant-id'] || '',
    userId: archive.userId || archive.UserId || envelope.userId || envelope.UserId || req.headers['x-user-id'] || unboundOwnerEmail(req, archive),
  });
  if (!scope) return undefined;
  const { tenantId, userId } = scope;
  if (!tenantId || !userId) {
    return res.status(400).json({ success: false, error: 'tenantId and userId are required' });
  }
  if (!meetingSourceAllowed({ req, config, tenantId, userId })) {
    return res.status(403).json({ success: false, error: 'Source is not enabled for this user: conference_bridge' });
  }

  const meetingId = stringField(archive, 'meetingId', 'MeetingId');
  const requestId = stringField(archive, 'requestId', 'RequestId') || meetingId;
  if (!meetingId || !requestId) {
    return res.status(400).json({ success: false, error: 'archive.meetingId and archive.requestId are required' });
  }

  try {
    await refreshStore(store);
    const document = meetingArchiveDocument({ tenantId, userId, archive, artifacts: envelope.artifacts || envelope.Artifacts || [] });
    await searchEngine.indexDocuments([document], { chunker: createChunks });
    const receipt = operationReceipt(operation, `${tenantId}:${userId}:${meetingId}:${requestId}`);
    store.audit({
      eventType: operation === 'archive' ? 'meeting_archive_accepted' : 'meeting_ingest_accepted',
      tenantId,
      userId,
      source: SOURCES.conference,
      metadata: {
        meetingId,
        requestId,
        documentId: document.id,
        receiptId: receipt.receiptId,
        selectedSourceScopes: archive.selectedSourceScopes || archive.SelectedSourceScopes || [],
        securityLabels: archive.securityLabels || archive.SecurityLabels || [],
      },
    });
    await store.save();
    return res.status(202).json({
      success: true,
      ok: true,
      id: receipt.receiptId,
      receiptId: receipt.receiptId,
      [`${operation}Id`]: receipt.receiptId,
      status: receipt.status,
      message: receipt.message,
      acceptedAtUtc: receipt.acceptedAtUtc,
      documentId: document.id,
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}

function meetingArchiveDocument({ tenantId, userId, archive, artifacts }) {
  const meetingId = stringField(archive, 'meetingId', 'MeetingId');
  const requestId = stringField(archive, 'requestId', 'RequestId') || meetingId;
  const transcript = arrayField(archive, 'transcript', 'Transcript').join('\n');
  const artifactText = Array.isArray(artifacts)
    ? artifacts.map((artifact) => [
      stringField(artifact, 'kind', 'Kind'),
      stringField(artifact, 'inlineContent', 'InlineContent'),
      stringField(artifact, 'uri', 'Uri'),
    ].filter(Boolean).join('\n')).filter(Boolean).join('\n\n')
    : '';
  const actionItems = arrayField(archive, 'actionItems', 'ActionItems');
  const pendingQuestions = arrayField(archive, 'pendingQuestions', 'PendingQuestions');
  const decisionLog = arrayField(archive, 'decisionLog', 'DecisionLog');
  const participants = arrayField(archive, 'participants', 'Participants');
  const participantContexts = arrayField(archive, 'participantContexts', 'ParticipantContexts');
  const knowledgeReferences = arrayField(archive, 'knowledgeReferences', 'KnowledgeReferences');
  const instructions = arrayField(archive, 'instructions', 'Instructions');
  const summary = stringField(archive, 'summary', 'Summary')
    || oneLine(transcript || artifactText || `Meeting ${meetingId}`);
  const title = `Meeting Archive: ${summary}`;
  const body = [
    `Meeting ID: ${meetingId}`,
    `Request ID: ${requestId}`,
    `Meet URL: ${stringField(archive, 'meetUrl', 'MeetUrl')}`,
    `Owner: ${stringField(archive, 'ownerDisplayName', 'OwnerDisplayName')} ${stringField(archive, 'ownerEmail', 'OwnerEmail')}`,
    `Bot: ${stringField(archive, 'botDisplayName', 'BotDisplayName')}`,
    `Agenda: ${stringField(archive, 'agenda', 'Agenda')}`,
    `Active participant: ${stringField(archive, 'activeParticipant', 'ActiveParticipant')} ${stringField(archive, 'activeParticipantId', 'ActiveParticipantId')}`,
    `Participants: ${participants.map(displayValue).join(', ')}`,
    `Action items: ${actionItems.map(displayValue).join('; ')}`,
    `Pending questions: ${pendingQuestions.map(displayValue).join('; ')}`,
    `Decisions: ${decisionLog.map(displayValue).join('; ')}`,
    `Instructions: ${instructions.map(displayValue).join('; ')}`,
    `Knowledge references: ${knowledgeReferences.map(displayValue).join('; ')}`,
    `Participant contexts: ${participantContexts.map(displayValue).join('; ')}`,
    transcript,
    artifactText,
  ].filter(Boolean).join('\n\n');

  return createDocument({
    tenantId,
    userId,
    source: SOURCES.conference,
    sourceId: `meeting:${meetingId}`,
    sourceUri: stringField(archive, 'meetUrl', 'MeetUrl') || `atlas-meeting://${meetingId}`,
    title,
    summary,
    body,
    author: stringField(archive, 'ownerDisplayName', 'OwnerDisplayName') || stringField(archive, 'ownerEmail', 'OwnerEmail') || userId,
    timestamp: stringField(archive, 'archivedAtUtc', 'ArchivedAtUtc') || new Date().toISOString(),
    container: 'meeting-archives',
    metadata: {
      kind: 'meeting_archive',
      meetingId,
      requestId,
      meetUrl: stringField(archive, 'meetUrl', 'MeetUrl'),
      ownerEmail: stringField(archive, 'ownerEmail', 'OwnerEmail') || userId,
      ownerDisplayName: stringField(archive, 'ownerDisplayName', 'OwnerDisplayName'),
      botDisplayName: stringField(archive, 'botDisplayName', 'BotDisplayName'),
      participationState: archive.participationState ?? archive.ParticipationState,
      activeParticipantId: stringField(archive, 'activeParticipantId', 'ActiveParticipantId'),
      effectiveSearchParticipantId: stringField(archive, 'effectiveSearchParticipantId', 'EffectiveSearchParticipantId'),
      selectedSourceScopes: arrayField(archive, 'selectedSourceScopes', 'SelectedSourceScopes'),
      securityLabels: arrayField(archive, 'securityLabels', 'SecurityLabels'),
      policy: archive.policy || archive.Policy || {},
      participantHints: arrayField(archive, 'participantHints', 'ParticipantHints'),
      participants,
      actionItems,
      pendingQuestions,
      decisionLog,
      relatedArtifacts: arrayField(archive, 'relatedArtifacts', 'RelatedArtifacts'),
      knowledgeReferences,
      recording: archive.recording || archive.Recording || null,
      artifactKinds: Array.isArray(artifacts) ? artifacts.map((artifact) => stringField(artifact, 'kind', 'Kind')).filter(Boolean) : [],
    },
    children: [
      ...transcriptSegments(transcript),
      ...actionItems.map((item, index) => ({ kind: 'action_item', title: `Action ${index + 1}`, text: displayValue(item), metadata: { index } })),
      ...pendingQuestions.map((item, index) => ({ kind: 'pending_question', title: `Question ${index + 1}`, text: displayValue(item), metadata: { index } })),
      ...decisionLog.map((item, index) => ({ kind: 'decision', title: `Decision ${index + 1}`, text: displayValue(item), metadata: { index } })),
    ],
  });
}

function transcriptSegments(transcript) {
  return String(transcript || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 500)
    .map((line, index) => {
      const [speaker, ...rest] = line.includes(':') ? line.split(':') : ['', line];
      return {
        kind: 'transcript_segment',
        title: speaker || `Turn ${index + 1}`,
        text: rest.join(':').trim() || line,
        metadata: { index, speaker: speaker || '' },
      };
    });
}

function meetingSourceAllowed({ req, config, tenantId, userId }) {
  const allowed = allowedSourcesOf(req);
  if (Array.isArray(allowed) && !allowed.includes(SOURCES.conference) && !allowed.includes('*')) return false;
  return sourceAllowed(config, tenantId, userId, SOURCES.conference);
}

function unboundOwnerEmail(req, payload) {
  if (req.identity?.bound) return '';
  return stringField(payload, 'ownerEmail', 'OwnerEmail');
}

function operationReceipt(operation, key) {
  return {
    receiptId: stableId(operation, key),
    status: 'accepted',
    message: `${operation} accepted`,
    acceptedAtUtc: new Date().toISOString(),
  };
}

function stableId(prefix, ...parts) {
  return `${prefix}_${hashQuery(parts.join(':')).replace(/^q_/, '')}`;
}

function stringField(value, ...names) {
  for (const name of names) {
    const entry = value?.[name];
    if (entry !== undefined && entry !== null && String(entry).trim()) return String(entry);
  }
  return '';
}

function numberField(value, ...names) {
  for (const name of names) {
    const entry = Number(value?.[name]);
    if (Number.isFinite(entry)) return entry;
  }
  return 0;
}

function arrayField(value, ...names) {
  for (const name of names) {
    const entry = value?.[name];
    if (Array.isArray(entry)) return entry;
    if (entry !== undefined && entry !== null && String(entry).trim()) return [entry];
  }
  return [];
}

function displayValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return [
    value.displayName || value.DisplayName,
    value.identityHint || value.IdentityHint,
    value.title || value.Title,
    value.summary || value.Summary,
    value.content || value.Content,
    value.text || value.Text,
    value.uri || value.Uri,
  ].filter(Boolean).join(' ') || JSON.stringify(value);
}

function recordingExtension(request) {
  const fileName = stringField(request, 'fileName', 'FileName');
  const fromFile = path.extname(fileName || '');
  if (fromFile) return fromFile;
  const contentType = stringField(request, 'contentType', 'ContentType').toLowerCase();
  if (contentType.includes('wav')) return '.wav';
  if (contentType.includes('webm')) return '.webm';
  if (contentType.includes('mp4')) return '.mp4';
  return '.bin';
}

function meetingRecordingStorage(config, recordingId, extension) {
  const safeExtension = extension || '.bin';
  const blobName = `meeting-recordings/${recordingId}${safeExtension}`;
  if (config.artifacts?.azureStorageConnectionString && config.artifacts?.container) {
    const publicBase = config.artifacts?.publicBaseUrl || '';
    return {
      backend: 'azure_blob',
      blobName,
      objectPath: '',
      recordingUri: publicBase
        ? `${publicBase.replace(/\/+$/, '')}/${blobName}`
        : `azure-blob://${config.artifacts.container}/${blobName}`,
    };
  }
  const objectPath = path.join(config.dataDir, 'meeting-recordings', `${recordingId}${safeExtension}`);
  return {
    backend: 'local',
    blobName: '',
    objectPath,
    recordingUri: `atlas-meeting-recording://${recordingId}`,
  };
}

async function storeMeetingRecordingBytes({ config, artifact, bytes }) {
  if (artifact.storageBackend === 'azure_blob') {
    const service = BlobServiceClient.fromConnectionString(config.artifacts.azureStorageConnectionString);
    const container = service.getContainerClient(config.artifacts.container);
    await container.createIfNotExists();
    const blob = container.getBlockBlobClient(artifact.blobName);
    await blob.uploadData(bytes, {
      blobHTTPHeaders: {
        blobContentType: artifact.contentType || 'application/octet-stream',
      },
      metadata: {
        tenantId: safeBlobMetadata(artifact.tenantId),
        userId: safeBlobMetadata(artifact.userId),
        meetingId: safeBlobMetadata(artifact.meetingId),
        requestId: safeBlobMetadata(artifact.requestId),
      },
    });
    return;
  }
  await mkdir(path.dirname(artifact.objectPath), { recursive: true });
  await writeFile(artifact.objectPath, bytes);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function safeBlobMetadata(value) {
  return String(value || '').replace(/[^\w.-]/g, '_').slice(0, 256);
}

function absoluteUrl(req, pathname) {
  const configured = req.app?.locals?.config?.publicBaseUrl || '';
  if (configured) return `${configured.replace(/\/+$/, '')}${pathname}`;
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}${pathname}`;
}

async function refreshStore(store) {
  if (typeof store.refresh !== 'function') return;
  if (typeof store.withStoreLock === 'function') {
    await store.withStoreLock(() => store.refresh());
    return;
  }
  await store.refresh();
}

async function deleteScopedDocuments({ res, config, store, tenantId, userId, source = '', documentIds = [], resetCheckpoints = false }) {
  if (!tenantId || !userId) {
    return res.status(400).json({ success: false, error: 'tenantId and userId are required' });
  }
  if (source && !sourceAllowed(config, tenantId, userId, source)) {
    return res.status(403).json({ success: false, error: `Source is not enabled for this user: ${source}` });
  }
  await refreshStore(store);
  const deleted = store.deleteDocuments({ tenantId, userId, source, documentIds });
  const checkpoints = resetCheckpoints ? store.deleteCheckpoints({ tenantId, userId, source }) : { deleted: 0 };
  store.audit({ eventType: 'documents_delete', tenantId, userId, source, metadata: { deleted: deleted.deleted, checkpointDeleted: checkpoints.deleted } });
  await store.save();
  return res.json({ success: true, source, deleted: deleted.deleted, checkpointDeleted: checkpoints.deleted, documentIds: deleted.documentIds });
}

async function enqueueConnectorEvent({ config, registry, store, jobs, source, tenantId, userId, event = {}, options = {}, wait = false }) {
  if (!sourceAllowed(config, tenantId, userId, source)) {
    const error = new Error(`Source is not enabled for this user: ${source}`);
    error.statusCode = 403;
    throw error;
  }
  const eventOptions = connectorEventOptions(source, event, options);
  await requireReadyConnector(registry, source, eventOptions, { tenantId, userId });
  await refreshStore(store);
  store.audit({
    eventType: 'connector_event_received',
    tenantId,
    userId,
    source,
    metadata: eventOptions.eventTrigger,
  });
  await store.save();
  const job = await jobs.enqueue({ source, tenantId, userId, options: eventOptions, autoStart: !wait });
  if (wait) {
    const result = await jobs.run(job.id, { source, tenantId, userId, options: eventOptions });
    return { job: result.job, indexed: result.indexed, eventTrigger: eventOptions.eventTrigger };
  }
  return { job, eventTrigger: eventOptions.eventTrigger };
}

async function requireReadyConnector(registry, source, options = {}, scope = {}) {
  if (options.fixtures) return;
  const [check] = await registry.readiness(source, scope);
  if (check?.ready) return;
  const missing = (check?.requirements || [])
    .filter((requirement) => !requirement.configured && !requirement.optional)
    .map((requirement) => requirement.name);
  const error = new Error(`Connector is not ready: ${source}`);
  error.statusCode = 409;
  error.details = {
    source,
    status: check?.status || 'not_reported',
    missing,
    error: check?.error,
  };
  throw error;
}

function matchesScope(req, row) {
  // Verified identity is authoritative; shared_token falls back to request IDs.
  const { tenantId, userId } = scopeOf(req, {
    tenantId: req.query.tenantId, userId: req.query.userId,
  });
  return Boolean(tenantId && userId && row.tenantId === tenantId && row.userId === userId);
}

function scopeFromRequest(req) {
  return scopeOf(req, {
    tenantId: req.query.tenantId || req.headers['x-tenant-id'] || '',
    userId: req.query.userId || req.headers['x-user-id'] || '',
  });
}

// Restrict requested sources to those the identity is entitled to (jwt/api_key
// `sources` claim). No claim → no extra restriction here (source-permission
// config still applies downstream).
function intersectAllowed(requested, allowed) {
  if (!Array.isArray(allowed)) return requested;
  const requestedList = Array.isArray(requested) && requested.length ? requested : allowed;
  return requestedList.filter((source) => allowed.includes(source));
}

function identityStatus(config) {
  const mode = config.identity?.mode || 'shared_token';
  const bound = mode === 'jwt' || mode === 'api_key';
  return {
    mode,
    // shared_token trusts caller-supplied scope → not safe for real multi-tenancy.
    multiTenantSafe: bound,
    detail: bound ? 'identity_bound_scope_verified' : 'shared_token_scope_trusted_not_multi_tenant_safe',
  };
}

function onboardingAdminOk(config, req) {
  const expected = config.onboarding?.adminToken || '';
  if (!expected) return true; // unguarded (dev/test); flagged in /v1/health
  const presented = req.headers['x-admin-token']
    || (String(req.headers.authorization || '').startsWith('Bearer ') ? req.headers.authorization.slice('Bearer '.length) : '');
  if (!presented) return false;
  const expectedBuffer = Buffer.from(expected);
  const presentedBuffer = Buffer.from(String(presented));
  return expectedBuffer.length === presentedBuffer.length && timingSafeEqual(expectedBuffer, presentedBuffer);
}

// Kick off the first sync so connecting a source begins vectorization with no
// extra call. Runs in the background; never fails the calling request.
async function autoBackfill(jobs, { source, tenantId, userId }) {
  try {
    const job = await jobs.enqueue({ source, tenantId, userId, options: {}, autoStart: true });
    return { jobId: job.id };
  } catch (error) {
    return { jobId: null, error: error.message };
  }
}

function onboardingStatus(config) {
  const guarded = Boolean(config.onboarding?.adminToken);
  const canMint = Boolean(config.identity?.jwtSecret);
  return {
    guarded,
    canMintTokens: canMint,
    detail: guarded ? 'admin_token_required' : 'unguarded_dev_only',
  };
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function isTerminalSearchRun(run) {
  return ['completed', 'partial', 'failed'].includes(run?.status);
}

function publicIndexStatus(status) {
  return {
    backend: status.backend,
    ready: ['postgres-pgvector', 'json'].includes(status.backend),
  };
}

function connectorEventOptions(source, event = {}, options = {}) {
  const trigger = eventTriggerSummary(source, event);
  const { fixtures: _fixtures, ...safeOptions } = options || {};
  const base = { ...safeOptions, eventTrigger: trigger };
  if (source === 'slack') {
    return {
      ...base,
      ...(event.channel ? { channelIds: [event.channel] } : {}),
      ...(event.ts || event.event_ts ? { sinceTs: event.thread_ts || event.ts || event.event_ts } : {}),
      limit: options.limit || 50,
    };
  }
  if (source === 'google_drive') {
    return {
      ...base,
      ...(event.folderIds?.length ? { folderIds: event.folderIds } : {}),
      ...(event.modifiedTime ? { modifiedAfter: event.modifiedTime } : {}),
      ...(event.resourceId ? { resourceId: event.resourceId } : {}),
      ...(event.channelId ? { channelId: event.channelId } : {}),
      limit: options.limit || 50,
    };
  }
  if (source === 'conference_bridge') {
    return {
      ...base,
      ...(event.prefix || event.blobPrefix ? { prefix: event.prefix || event.blobPrefix } : {}),
    };
  }
  if (source === 'data_fabric') {
    return {
      ...base,
      ...(event.dataset ? { dataset: event.dataset } : {}),
      limit: options.limit || 50,
    };
  }
  return base;
}

function verifySlackSignature(config, req) {
  const signingSecret = config.slack?.signingSecret || '';
  if (!signingSecret) return { ok: false, status: 503, error: 'SLACK_SIGNING_SECRET is not configured' };
  const timestamp = String(req.headers['x-slack-request-timestamp'] || '');
  const signature = String(req.headers['x-slack-signature'] || '');
  const timestampSeconds = Number(timestamp);
  if (!timestamp || !Number.isFinite(timestampSeconds)) return { ok: false, status: 401, error: 'Invalid Slack timestamp' };
  if (Math.abs(Date.now() / 1000 - timestampSeconds) > 300) return { ok: false, status: 401, error: 'Stale Slack timestamp' };
  if (!signature.startsWith('v0=')) return { ok: false, status: 401, error: 'Invalid Slack signature' };
  const expected = `v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:${req.rawBody || ''}`).digest('hex')}`;
  if (!constantTimeEquals(signature, expected)) return { ok: false, status: 401, error: 'Invalid Slack signature' };
  return { ok: true };
}

function verifyGoogleDriveWebhook(config, req) {
  const expectedToken = config.gdrive?.webhookToken || '';
  if (!expectedToken) return { ok: false, status: 503, error: 'GDRIVE_WEBHOOK_TOKEN is not configured' };
  const token = String(req.headers['x-goog-channel-token'] || '');
  if (!constantTimeEquals(token, expectedToken)) return { ok: false, status: 401, error: 'Invalid Google Drive channel token' };
  const channelId = String(req.headers['x-goog-channel-id'] || '');
  if (!channelId) return { ok: false, status: 400, error: 'Missing Google Drive channel id' };
  const allowedChannelIds = config.gdrive?.webhookChannelIds || [];
  if (allowedChannelIds.length && !allowedChannelIds.includes(channelId)) {
    return { ok: false, status: 401, error: 'Unexpected Google Drive channel id' };
  }
  const resourceId = String(req.headers['x-goog-resource-id'] || '');
  if (!resourceId) return { ok: false, status: 400, error: 'Missing Google Drive resource id' };
  return { ok: true };
}

function verifyAzureBlobWebhook(config, req) {
  const expectedToken = config.conference?.eventGridToken || '';
  if (!expectedToken) return { ok: false, status: 503, error: 'CONFERENCE_EVENT_GRID_TOKEN is not configured' };
  const token = String(req.headers['x-atlas-event-grid-token'] || req.query?.token || '');
  if (!constantTimeEquals(token, expectedToken)) return { ok: false, status: 401, error: 'Invalid Azure Event Grid token' };
  return { ok: true };
}

function parseBlobEventSubject(value) {
  const text = decodeURIComponent(String(value || ''));
  let match = text.match(/\/containers\/([^/]+)\/blobs\/(.+)$/);
  if (match) return { container: match[1], blobName: match[2] };
  match = text.match(/https?:\/\/[^/]+\/([^/?#]+)\/([^?#]+)/);
  if (match) return { container: match[1], blobName: match[2] };
  return { container: '', blobName: '' };
}

function constantTimeEquals(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function eventTriggerSummary(source, event = {}) {
  return {
    source,
    eventType: event.type || event.eventType || 'connector_event',
    eventId: event.event_id || event.eventId || event.id || '',
    receivedAt: new Date().toISOString(),
    channelId: event.channel || '',
    fileId: event.fileId || event.file_id || '',
    resourceId: event.resourceId || event.resource_id || '',
    resourceState: event.resourceState || event.resource_state || '',
    driveChannelId: event.channelId || event.channel_id || '',
    dataset: event.dataset || '',
    prefix: event.prefix || event.blobPrefix || '',
  };
}

function dataFabricRecords({ store, tenantId, userId, dataset, limit }) {
  const index = store.scopedStatus({ tenantId, userId });
  const audit = store.listAudit({ tenantId, userId, limit });
  const now = new Date().toISOString();
  const normalizedDataset = String(dataset || 'operational_summary');
  const records = [];

  if (['index_status', 'operational_summary', 'all'].includes(normalizedDataset)) {
    records.push({
      id: `index_status:${tenantId}:${userId}`,
      dataset: 'index_status',
      title: 'Unified search index status',
      summary: `${index.documents} documents and ${index.chunks} chunks indexed for ${tenantId}/${userId}.`,
      text: `Unified search index has ${index.documents} documents and ${index.chunks} chunks. Source counts: ${JSON.stringify(index.bySource || {})}.`,
      timestamp: now,
      record: {
        tenantId,
        userId,
        backend: index.backend,
        documents: index.documents,
        chunks: index.chunks,
        bySource: index.bySource || {},
      },
      metadata: { source: 'unified_search', kind: 'index_status' },
    });
  }

  if (['audit_events', 'operational_summary', 'all'].includes(normalizedDataset)) {
    for (const event of audit.slice(0, Math.max(limit - records.length, 0))) {
      records.push({
        id: `audit:${event.id}`,
        dataset: 'audit_events',
        title: `Audit event: ${event.eventType}`,
        summary: `Audit ${event.eventType} at ${event.createdAt}.`,
        text: `Audit event ${event.eventType} for ${tenantId}/${userId}. Metadata: ${JSON.stringify(event.metadata || {})}.`,
        timestamp: event.createdAt || now,
        record: {
          id: event.id,
          tenantId,
          userId,
          eventType: event.eventType,
          createdAt: event.createdAt,
          metadata: event.metadata || {},
        },
        metadata: { source: 'unified_search', kind: 'audit_event' },
      });
    }
  }

  return records.slice(0, limit);
}

function hashQuery(query) {
  let hash = 0;
  for (const char of String(query || '')) hash = Math.imul(31, hash) + char.charCodeAt(0) | 0;
  return `q_${Math.abs(hash)}`;
}

function filterAllowedSources(config, tenantId, userId, sources = []) {
  const selected = Array.isArray(sources) ? sources.filter(Boolean) : [];
  if (!hasSourcePermissions(config)) return selected;
  if (!selected.length) return allowedSourcesFor(config, tenantId, userId);
  return selected.filter((source) => sourceAllowed(config, tenantId, userId, source));
}

function sourceAllowed(config, tenantId, userId, source) {
  const permissions = config.sourcePermissions || {};
  if (!hasSourcePermissions(config)) return true;
  const candidates = [
    `${tenantId}:${userId}`,
    `${tenantId}:*`,
    `*:${userId}`,
    '*:*',
  ];
  for (const key of candidates) {
    const allowed = permissions[key];
    if (Array.isArray(allowed)) return allowed.includes(source) || allowed.includes('*');
  }
  return false;
}

function allowedSourcesFor(config, tenantId, userId) {
  const permissions = config.sourcePermissions || {};
  const candidates = [
    `${tenantId}:${userId}`,
    `${tenantId}:*`,
    `*:${userId}`,
    '*:*',
  ];
  for (const key of candidates) {
    const allowed = permissions[key];
    if (Array.isArray(allowed)) return allowed;
  }
  return [];
}

function hasSourcePermissions(config) {
  return Boolean(config.sourcePermissions && Object.keys(config.sourcePermissions).length);
}

function productionReadinessReport({ config, store, queue, assistant, connectorChecks }) {
  const checksBySource = Object.fromEntries(connectorChecks.map((check) => [check.source, check]));
  const infrastructure = {
    apiAuth: { ready: Boolean(config.auth?.required), detail: config.auth?.required ? 'required' : 'not_required' },
    cors: corsStatus(config),
    index: { ready: store.status().backend === 'postgres-pgvector', detail: store.status().backend },
    queue: { ready: queue.name === 'azure-service-bus', detail: queue.name },
    artifacts: { ready: assistant.artifactProvider.name === 'azure-blob-artifact' && assistant.artifactProvider.configured(), detail: assistant.artifactProvider.name },
    scheduler: scheduleStatus(config),
    retention: retentionStatus(config),
  };
  const liveSources = ['email', 'conference_bridge', 'knowledge_base']
    .map((source) => ({ source, ready: Boolean(checksBySource[source]?.ready), status: checksBySource[source]?.status || 'not_reported' }));
  const credentialBlockedSources = ['slack', 'google_drive']
    .filter((source) => !checksBySource[source]?.ready)
    .map((source) => ({
      source,
      status: checksBySource[source]?.status || 'not_reported',
      missing: (checksBySource[source]?.requirements || [])
        .filter((requirement) => !requirement.configured && !requirement.optional)
        .map((requirement) => requirement.name),
    }));
  const liveButExternal = ['slack', 'google_drive']
    .filter((source) => checksBySource[source]?.ready)
    .map((source) => ({ source, status: checksBySource[source].status }));
  const futureSources = ['data_fabric']
    .map((source) => ({ source, ready: Boolean(checksBySource[source]?.ready), status: checksBySource[source]?.status || 'not_reported' }));
  const webhookIngress = webhookIngressReadiness(config);
  const fixtureOnly = [
    {
      source: 'slack',
      status: 'fixture_pipeline_only_until_live_readiness',
      proves: ['normalization shape', 'Service Bus worker path', 'Postgres/pgvector indexing', 'search', 'assistant artifacts'],
      doesNotProve: ['Slack token validity', 'Slack channel access', 'Slack history/thread/file API calls'],
    },
    {
      source: 'google_drive',
      status: 'fixture_tests_only_until_live_readiness',
      proves: ['document shape', 'index/search behavior'],
      doesNotProve: ['Google OAuth/service account validity', 'Drive file listing/export/download'],
    },
  ];
  const infrastructureReady = Object.values(infrastructure).every((item) => item.ready);
  const requiredLiveSourcesReady = liveSources.every((item) => item.ready);
  return {
    generatedAt: new Date().toISOString(),
    readyForProductionTesting: infrastructureReady && requiredLiveSourcesReady,
    productionComplete: infrastructureReady
      && requiredLiveSourcesReady
      && credentialBlockedSources.length === 0
      && futureSources.every((item) => item.ready)
      && webhookIngress.every((item) => item.ready),
    infrastructure,
    liveSources,
    liveButExternal,
    credentialBlockedSources,
    futureSources,
    webhookIngress,
    fixtureOnly,
    nextActions: [
      ...(credentialBlockedSources.some((item) => item.source === 'slack') ? ['Configure SLACK_BOT_TOKEN and SLACK_CHANNEL_IDS, then run /v1/reindex/slack with a real channel.'] : []),
      ...(credentialBlockedSources.some((item) => item.source === 'google_drive') ? ['Configure Google OAuth refresh token or service account, then run /v1/reindex/google_drive with a real folder.'] : []),
      ...webhookIngress.filter((item) => !item.ready).map((item) => `Configure ${item.name} webhook ingress: missing ${item.missing.join(', ')}.`),
      ...(futureSources.some((item) => item.source === 'data_fabric' && !item.ready) ? ['Define and configure the Data Fabric API contract before claiming live Data Fabric readiness.'] : []),
    ],
  };
}

function retentionStatus(config) {
  const retention = config.retention || {};
  const documentDays = retention.documentDays || 90;
  const operationalDays = retention.operationalDays || 30;
  const auditDays = retention.auditDays || 90;
  return {
    ready: [documentDays, operationalDays, auditDays].every((value) => Number(value) > 0),
    detail: {
      documentDays,
      operationalDays,
      auditDays,
    },
  };
}

function corsStatus(config) {
  const origins = config.cors?.origins || [];
  return {
    ready: !config.auth?.required || origins.length > 0,
    detail: origins.length ? 'allowlist_configured' : 'allow_all_origins',
    allowedOriginCount: origins.length,
  };
}

function corsOptions(config) {
  const allowedOrigins = config.cors?.origins || [];
  if (!allowedOrigins.length) return {};
  const allowed = new Set(allowedOrigins);
  return {
    origin(origin, callback) {
      if (!origin || allowed.has(origin)) return callback(null, true);
      return callback(null, false);
    },
  };
}

function webhookIngressReadiness(config) {
  return [
    webhookGate('slack_events', '/v1/webhooks/slack/events', [
      ['SLACK_SIGNING_SECRET', config.slack?.signingSecret],
      ['SLACK_EVENT_TENANT_ID', config.slack?.eventTenantId],
      ['SLACK_EVENT_USER_ID', config.slack?.eventUserId],
    ]),
    webhookGate('google_drive_changes', '/v1/webhooks/google-drive/changes', [
      ['GDRIVE_WEBHOOK_TOKEN', config.gdrive?.webhookToken],
      ['GDRIVE_WEBHOOK_CHANNEL_IDS', config.gdrive?.webhookChannelIds?.length],
      ['GDRIVE_EVENT_TENANT_ID', config.gdrive?.eventTenantId],
      ['GDRIVE_EVENT_USER_ID', config.gdrive?.eventUserId],
    ]),
    webhookGate('azure_blob_event_grid', '/v1/webhooks/azure-blob/events', [
      ['CONFERENCE_EVENT_GRID_TOKEN', config.conference?.eventGridToken],
      ['CONFERENCE_EVENT_TENANT_ID', config.conference?.eventTenantId],
      ['CONFERENCE_EVENT_USER_ID', config.conference?.eventUserId],
    ]),
  ];
}

function webhookGate(name, path, requirements) {
  const missing = requirements
    .filter(([, value]) => !value)
    .map(([envName]) => envName);
  return {
    name,
    path,
    ready: missing.length === 0,
    status: missing.length ? 'missing_configuration' : 'configured',
    missing,
  };
}

function scheduleStatus(config) {
  try {
    const schedules = parseSyncSchedules(config.syncSchedulesRaw || '');
    return {
      ready: schedules.length > 0 || !config.schedulerRequired,
      detail: schedules.length ? 'configured' : 'not_configured_manual_only',
      required: Boolean(config.schedulerRequired),
      schedules: summarizeSchedules(schedules),
    };
  } catch (error) {
    return {
      ready: false,
      detail: 'invalid_configuration',
      error: error.message,
      schedules: [],
    };
  }
}

function connectorSetupGuide(checks) {
  return checks.map((check) => {
    const missing = check.ready ? [] : (check.requirements || [])
      .filter((requirement) => !requirement.configured && !requirement.optional)
      .filter((requirement) => !requirement.recommended)
      .map((requirement) => requirement.name);
    const base = {
      source: check.source,
      ready: Boolean(check.ready),
      status: check.status,
      missing,
      requirements: check.requirements || [],
      vectorizationMode: check.vectorizationMode || 'local_index',
      vectorizationBoundary: vectorizationBoundary(check.source, check.vectorizationMode || 'local_index'),
      nextAction: setupNextAction(check.source, missing, check),
      liveSmoke: liveSmokeGuide(check.source),
    };
    return base;
  });
}

function vectorizationBoundary(source, mode) {
  if (source === 'email' && mode === 'external_federated') {
    return 'Email search is federated into the existing Atlas email vector service; unified search does not create or store email embeddings for this path.';
  }
  return 'This connector is indexed and vectorized inside unified search for the tenant/user scope used by sync or reindex jobs.';
}

function setupNextAction(source, missing, check) {
  if (check.ready) {
    return 'Run production smoke reindex/search for this connector with a small known-readable scope.';
  }
  if (source === 'slack') {
    return missing.length
      ? 'Install the Slack app, invite the bot to at least one channel, then wire SLACK_BOT_TOKEN and SLACK_CHANNEL_IDS into both Container Apps.'
      : 'Slack configuration exists but readiness failed; verify bot scopes and channel membership.';
  }
  if (source === 'google_drive') {
    return missing.length
      ? 'Create Google Drive OAuth refresh-token or service-account credentials, grant file/folder access, then wire the Google secret set into both Container Apps.'
      : 'Google Drive configuration exists but readiness failed; verify consent, refresh token validity, service-account sharing, and Drive API access.';
  }
  if (source === 'data_fabric') {
    return missing.includes('DATA_FABRIC_BASE_URL')
      ? 'Deploy or identify the Data Fabric HTTP service and wire DATA_FABRIC_BASE_URL into both Container Apps.'
      : 'Data Fabric configuration exists but readiness failed; verify /health and /records contract responses.';
  }
  if (source === 'conference_bridge') {
    return 'Wire AZURE_STORAGE_CONNECTION_STRING and CONFERENCE_BLOB_CONTAINERS, then run the conference bridge live smoke.';
  }
  if (source === 'knowledge_base') {
    return 'Wire KNOWLEDGE_BASE_ROOT to a mounted or image-bundled docs root, then run the knowledge base live smoke.';
  }
  if (source === 'email') {
    return 'Wire EMAIL_VECTOR_SEARCH_URL and EMAIL_READINESS_USER_EMAIL to the Atlas email backend, then run email readiness and search smoke.';
  }
  return 'Configure required connector settings and run readiness.';
}

async function notifySourceConnectCallback(config, { sourceId, email, credentialRef, providerId }) {
  const base = (config.sourceLifecycle?.connectCallbackUrl || '').replace(/\/$/, '');
  const token = config.sourceLifecycle?.connectCallbackToken || '';
  if (!base || !token) return;
  const url = `${base}/v1/sources/${sourceId}/connect-callback`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_email: email, credential_ref: credentialRef, provider_id: providerId }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || data.code || `http_${response.status}`);
  }
}

function liveSmokeGuide(source) {
  const guides = {
    slack: {
      command: 'UNIFIED_SEARCH_SMOKE_MODE=async npm run smoke:production',
      env: ['UNIFIED_SEARCH_SMOKE_SLACK_CHANNEL_IDS', 'UNIFIED_SEARCH_SMOKE_SLACK_QUERY'],
    },
    google_drive: {
      command: 'UNIFIED_SEARCH_SMOKE_MODE=async npm run smoke:production',
      env: ['UNIFIED_SEARCH_SMOKE_GDRIVE_FOLDER_IDS', 'UNIFIED_SEARCH_SMOKE_GDRIVE_QUERY'],
    },
    data_fabric: {
      command: 'UNIFIED_SEARCH_SMOKE_MODE=async npm run smoke:production',
      env: ['UNIFIED_SEARCH_SMOKE_DATA_FABRIC_DATASET', 'UNIFIED_SEARCH_SMOKE_DATA_FABRIC_QUERY'],
    },
    conference_bridge: {
      command: 'UNIFIED_SEARCH_SMOKE_MODE=async npm run smoke:production',
      env: ['UNIFIED_SEARCH_SMOKE_CONFERENCE_PREFIX'],
    },
    knowledge_base: {
      command: 'UNIFIED_SEARCH_SMOKE_MODE=async npm run smoke:production',
      env: [],
    },
    email: {
      command: 'npm run smoke:production:ui && UNIFIED_SEARCH_SMOKE_MODE=async npm run smoke:production',
      env: [],
    },
  };
  return guides[source] || { command: 'UNIFIED_SEARCH_SMOKE_MODE=async npm run smoke:production', env: [] };
}
