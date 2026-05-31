import { createDocument, oneLine, SOURCES } from '../model.js';
import { checkpointKey } from './base.js';

const SLACK_API_BASE = 'https://slack.com/api';

export class SlackConnector {
  constructor(config) {
    this.source = SOURCES.slack;
    this.config = config.slack;
    this.practical = true;
    this.description = 'Slack bot-token connector for messages, threads, links, and file metadata.';
  }

  isConfigured() {
    return Boolean(this.config.botToken && this.config.channelIds.length);
  }

  requirements() {
    return [
      { name: 'SLACK_BOT_TOKEN', configured: Boolean(this.config.botToken) },
      { name: 'SLACK_CHANNEL_IDS', configured: Boolean(this.config.channelIds.length) },
    ];
  }

  async checkReadiness() {
    const auth = await this.call('auth.test', {});
    const channelChecks = [];
    for (const channelId of this.config.channelIds.slice(0, 5)) {
      const channel = await this.call('conversations.info', { channel: channelId });
      channelChecks.push({ channelId, name: channel.channel?.name || channelId, accessible: true });
    }
    return {
      ready: true,
      status: 'ok',
      details: {
        team: auth.team,
        botUserId: auth.user_id,
        checkedChannels: channelChecks,
        configuredChannelCount: this.config.channelIds.length,
      },
    };
  }

  async sync({ tenantId, userId, store, options = {} }) {
    if (options.fixtures) return options.fixtures.map((item) => slackFixtureToDocument({ tenantId, userId, item }));
    if (!this.isConfigured()) throw new Error('Slack connector is not configured');
    const channelIds = options.channelIds?.length ? options.channelIds : this.config.channelIds;
    const documents = [];
    for (const channelId of channelIds) {
      const key = checkpointKey(this.source, tenantId, userId, `channel:${channelId}`);
      const checkpoint = options.forceFullSync ? null : store?.getCheckpoint(key);
      const oldest = options.sinceTs || checkpoint?.latestTs || '';
      const channel = await this.call('conversations.info', { channel: channelId }).catch(() => ({ channel: { id: channelId, name: channelId } }));
      const messages = await this.paginate('conversations.history', {
        channel: channelId,
        limit: String(options.limit || this.config.limit),
        ...(oldest ? { oldest } : {}),
      }, 'messages');
      let latestTs = checkpoint?.latestTs || '';
      for (const message of messages) {
        if (!message.ts || message.subtype === 'message_deleted') continue;
        const replies = message.thread_ts ? await this.paginate('conversations.replies', { channel: channelId, ts: message.thread_ts, limit: '200' }, 'messages') : [];
        const permalink = await this.call('chat.getPermalink', { channel: channelId, message_ts: message.ts }).then((data) => data.permalink).catch(() => '');
        documents.push(slackMessageToDocument({ tenantId, userId, channel: channel.channel, message, replies, permalink }));
        if (!latestTs || slackTsNumber(message.ts) > slackTsNumber(latestTs)) latestTs = message.ts;
      }
      if (store && latestTs) {
        store.setCheckpoint(key, {
          source: this.source,
          channelId,
          channelName: channel.channel?.name || channelId,
          latestTs,
          lastSyncedAt: new Date().toISOString(),
          syncedMessages: messages.length,
        });
      }
    }
    return documents;
  }

  async paginate(method, params, key) {
    const items = [];
    let cursor = '';
    do {
      const data = await this.call(method, cursor ? { ...params, cursor } : params);
      items.push(...(data[key] || []));
      cursor = data.response_metadata?.next_cursor || '';
    } while (cursor);
    return items;
  }

  async call(method, params) {
    const response = await fetch(`${SLACK_API_BASE}/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.botToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.error || `Slack ${method} failed`);
    return data;
  }
}

function slackFixtureToDocument({ tenantId, userId, item }) {
  return createDocument({
    tenantId,
    userId,
    source: SOURCES.slack,
    sourceId: item.sourceId || `${item.channelId}:${item.timestamp}`,
    sourceUri: item.permalink || '',
    title: item.title || `#${item.channelName || item.channelId}`,
    summary: item.summary || oneLine(item.text),
    body: item.text || '',
    author: item.sender || '',
    timestamp: item.timestamp || new Date().toISOString(),
    container: item.channelName || item.channelId || '',
    metadata: { channelId: item.channelId, links: item.links || [], files: item.files || [] },
    children: [
      ...(item.thread || []).map((reply) => ({ kind: 'thread_reply', title: reply.sender, text: reply.text, timestamp: reply.timestamp })),
      ...(item.files || []).map((file) => ({ kind: 'attachment', title: file.name || file.title, text: file.text || file.name || '', metadata: file })),
    ],
  });
}

function slackMessageToDocument({ tenantId, userId, channel, message, replies, permalink }) {
  const text = clean(message.text || '');
  const files = normalizeFiles(message.files || []);
  return createDocument({
    tenantId,
    userId,
    source: SOURCES.slack,
    sourceId: `${channel.id}:${message.ts}`,
    sourceUri: permalink,
    title: `#${channel.name || channel.id}`,
    summary: oneLine(text),
    body: text,
    author: message.user || message.username || message.bot_id || 'unknown',
    timestamp: slackTsToIso(message.ts),
    container: channel.name || channel.id,
    metadata: { channelId: channel.id, channelName: channel.name, messageTs: message.ts, links: extractLinks(text), files },
    children: [
      ...replies.filter((reply) => reply.ts !== message.ts).map((reply) => ({ kind: 'thread_reply', title: reply.user || reply.username || 'reply', text: clean(reply.text || ''), timestamp: slackTsToIso(reply.ts) })),
      ...files.map((file) => ({ kind: 'attachment', title: file.name, text: `${file.name} ${file.title} ${file.mimetype}`, metadata: file })),
    ],
  });
}

function clean(value) {
  return String(value || '').replace(/<([^|>]+)\|([^>]+)>/g, '$2').replace(/<([^>]+)>/g, '$1').replace(/\s+/g, ' ').trim();
}

function extractLinks(text) {
  return [...new Set(String(text || '').match(/https?:\/\/[^\s<>)"]+/g) || [])];
}

function normalizeFiles(files) {
  return files.map((file) => ({ id: file.id, name: file.name || file.title || 'attachment', title: file.title || file.name || '', mimetype: file.mimetype || '', url: file.url_private || '', permalink: file.permalink || '' }));
}

function slackTsToIso(ts) {
  const seconds = Number(String(ts).split('.')[0]);
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : new Date().toISOString();
}

function slackTsNumber(ts) {
  const value = Number(ts);
  return Number.isFinite(value) ? value : 0;
}
