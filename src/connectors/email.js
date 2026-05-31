import { createDocument, oneLine, SOURCES } from '../model.js';

export class EmailConnector {
  constructor(config) {
    this.source = SOURCES.email;
    this.config = config.email;
    this.practical = true;
    this.description = 'Atlas Email connector over the email assistant backend or supplied fixtures.';
  }

  isConfigured() {
    return Boolean(this.config.baseUrl && this.config.sessionId);
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
