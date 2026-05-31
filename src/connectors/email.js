import { createDocument, oneLine, SOURCES } from '../model.js';

export class EmailConnector {
  constructor(config) {
    this.source = SOURCES.email;
    this.config = config.email;
    this.practical = true;
    this.description = 'Atlas Email connector over the email assistant backend or supplied fixtures.';
  }

  isConfigured() {
    return Boolean((this.config.baseUrl && this.config.sessionId) || this.config.searchUrl);
  }

  requirements() {
    return [
      { name: 'EMAIL_VECTOR_SEARCH_URL', configured: Boolean(this.config.searchUrl), recommended: true },
      { name: 'EMAIL_CONNECTOR_API_TOKEN', configured: Boolean(this.config.apiToken), recommended: true },
      { name: 'EMAIL_CONNECTOR_BASE_URL', configured: Boolean(this.config.baseUrl), alternativeGroup: 'legacy_fetch' },
      { name: 'EMAIL_CONNECTOR_SESSION_ID', configured: Boolean(this.config.sessionId), alternativeGroup: 'legacy_fetch' },
    ];
  }

  async checkReadiness() {
    if (this.config.searchUrl) {
      const response = await fetch(this.config.searchUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiToken ? { Authorization: `Bearer ${this.config.apiToken}` } : {}),
        },
        body: JSON.stringify({
          tenantId: 'readiness',
          userId: 'readiness',
          userEmail: this.config.readinessUserEmail || 'readiness@atlasweb.info',
          query: 'readiness',
          sources: ['email'],
          filters: { limit: 1 },
          size: 1,
        }),
      });
      const data = await response.json().catch(() => ({}));
      const message = data.error || data.message || '';
      if (response.status === 500 && /Collection .*doesn'?t exist|not found/i.test(message)) {
        return {
          ready: true,
          status: 'ok_no_readiness_collection',
          details: {
            statusCode: response.status,
            message: 'Endpoint contract is valid; readiness probe user has no indexed email collection.',
          },
        };
      }
      if (!response.ok && response.status !== 404) {
        return { ready: false, status: `http_${response.status}`, details: { message: message || 'Email vector search rejected readiness probe' } };
      }
      return {
        ready: response.ok,
        status: response.ok ? 'ok' : 'endpoint_reachable_contract_unconfirmed',
        details: {
          statusCode: response.status,
          resultCount: Array.isArray(data.results) ? data.results.length : Array.isArray(data.data?.results) ? data.data.results.length : undefined,
        },
      };
    }
    return { ready: true, status: 'legacy_fetch_configured', details: { baseUrlConfigured: Boolean(this.config.baseUrl) } };
  }

  async search({ tenantId, userId, query, filters = {}, limit = 10 }) {
    if (!this.config.searchUrl) return null;
    const response = await fetch(this.config.searchUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.config.apiToken ? { Authorization: `Bearer ${this.config.apiToken}` } : {}),
      },
      body: JSON.stringify({
        tenantId,
        userId,
        userEmail: userId,
        query,
        filters: normalizeEmailFilters(filters, limit),
        size: limit,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) throw new Error(data.error || data.message || 'Federated email search failed');
    const results = data.results || data.items || data.data?.results || [];
    return results.map((item) => ({
      id: item.id || item.documentId || item.messageId,
      source: SOURCES.email,
      title: item.title || item.subject || '(no subject)',
      oneLine: item.oneLine || item.summary || oneLine(item.body || item.preview),
      author: item.author || item.sender || item.from || '',
      timestamp: item.timestamp || item.receivedAt || item.receivedDateTime || new Date().toISOString(),
      container: item.container || item.folder || 'Inbox',
      score: Number(item.score || 0.5),
      sourceUri: item.sourceUri || item.webLink || '',
      children: item.children || [],
      metadata: item.metadata || { attachments: item.attachments || [] },
    }));
  }

  async sync({ tenantId, userId, options = {} }) {
    if (options.fixtures) return options.fixtures.map((item) => emailFixtureToDocument({ tenantId, userId, item }));
    if (!this.isConfigured()) throw new Error('Email connector is not configured');
    const url = new URL('/fetch-emails-imap', this.config.baseUrl);
    url.searchParams.set('limit', String(options.limit || this.config.limit));
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.config.sessionId}` },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) throw new Error(data.error || data.message || 'Email fetch failed');
    const emails = data.emails || data.messages || [];
    return emails.map((email) => emailMessageToDocument({ tenantId, userId, email }));
  }
}

function normalizeEmailFilters(filters = {}, limit = 10) {
  return {
    ...filters,
    limit,
    sender_email: filters.sender_email || filters.sender || undefined,
    date_from: filters.date_from || filters.from || undefined,
    date_to: filters.date_to || filters.to || undefined,
  };
}

function emailFixtureToDocument({ tenantId, userId, item }) {
  return createDocument({
    tenantId,
    userId,
    source: SOURCES.email,
    sourceId: item.messageId || item.id,
    sourceUri: item.webLink || '',
    title: item.subject || '(no subject)',
    summary: item.summary || oneLine(item.body || item.preview),
    body: item.body || item.preview || '',
    author: item.sender || item.from || '',
    timestamp: item.receivedAt || item.timestamp || new Date().toISOString(),
    container: item.mailbox || item.folder || 'Inbox',
    metadata: { messageId: item.messageId || item.id, threadId: item.threadId, recipients: item.recipients || [], attachments: item.attachments || [] },
    children: [
      ...(item.thread || []).map((reply) => ({ kind: 'email_reply', title: reply.sender, text: reply.body || reply.preview || '', timestamp: reply.receivedAt })),
      ...(item.attachments || []).map((attachment) => ({ kind: 'attachment', title: attachment.name, text: attachment.text || attachment.name, metadata: attachment })),
    ],
  });
}

function emailMessageToDocument({ tenantId, userId, email }) {
  const sender = email.senderName || email.senderEmail || email.from?.emailAddress?.address || email.from || '';
  const body = email.bodyPreview || email.preview || email.text || email.body?.content || '';
  return createDocument({
    tenantId,
    userId,
    source: SOURCES.email,
    sourceId: email.id || email.messageId,
    sourceUri: email.webLink || '',
    title: email.subject || '(no subject)',
    summary: oneLine(body),
    body,
    author: sender,
    timestamp: email.receivedDateTime || email.receivedAt || email.date || new Date().toISOString(),
    container: email.folder || email.mailbox || 'Inbox',
    metadata: { messageId: email.id || email.messageId, threadId: email.conversationId || email.threadId, attachments: email.attachments || [] },
    children: (email.attachments || []).map((attachment) => ({ kind: 'attachment', title: attachment.name, text: attachment.text || attachment.name, metadata: attachment })),
  });
}
