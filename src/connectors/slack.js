import { createDocument, oneLine, SOURCES } from '../model.js';
import { checkpointKey } from './base.js';

const SLACK_API_BASE = 'https://slack.com/api';

export class SlackConnector {
  constructor(config, tokenProvider = null) {
    this.source = SOURCES.slack;
    this.config = config.slack;
    this.tokenProvider = tokenProvider;
    this.userNames = new Map();
    this.practical = true;
    this.description = 'Slack bot-token connector for messages, threads, links, and file metadata.';
  }

  isConfigured(scope = {}) {
    const credentials = this.credentials(scope);
    return Boolean(credentials.botToken);
  }

  requirements(scope = {}) {
    const credentials = this.credentials(scope);
    const requirements = [
      { name: 'SLACK_BOT_TOKEN', configured: Boolean(this.config.botToken) },
      { name: 'SLACK_CHANNEL_IDS', configured: Boolean(this.config.channelIds.length) },
    ];
    if (this.tokenProvider) return this.tokenProvider.requirements(this.source, scope, requirements);
    return requirements.map((requirement) => ({
      ...requirement,
      configured: requirement.name === 'SLACK_BOT_TOKEN' ? Boolean(credentials.botToken) : Boolean(credentials.channelIds?.length),
    }));
  }

  async checkReadiness(scope = {}) {
    const auth = await this.call('auth.test', {}, scope);
    const channelChecks = [];
    const credentials = this.credentials(scope);
    for (const channelId of credentials.channelIds.slice(0, 5)) {
      const channel = await this.call('conversations.info', { channel: channelId }, scope);
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
    const scope = { tenantId, userId };
    if (!this.isConfigured(scope)) throw new Error('Slack connector is not configured');
    if (options.eventPayload) {
      const document = await this.eventDocument({ tenantId, userId, event: options.eventPayload, scope });
      return document ? [document] : [];
    }
    const credentials = this.credentials(scope);
    const channelIds = options.channelIds?.length
      ? options.channelIds
      : credentials.channelIds.length
        ? credentials.channelIds
        : await this.discoverMemberChannels(scope);
    if (!channelIds.length) {
      throw new Error('Slack app is not a member of any readable channels');
    }
    const documents = [];
    for (const channelId of channelIds) {
      const key = checkpointKey(this.source, tenantId, userId, `channel:${channelId}`);
      const checkpoint = options.forceFullSync ? null : store?.getCheckpoint(key);
      const oldest = options.sinceTs || checkpoint?.latestTs || '';
      const channel = await this.call('conversations.info', { channel: channelId }, scope).catch(() => ({ channel: { id: channelId, name: channelId } }));
      const messages = await this.paginate('conversations.history', {
        channel: channelId,
        limit: String(options.limit || this.config.limit),
        ...(oldest ? { oldest } : {}),
      }, 'messages', scope);
      let latestTs = checkpoint?.latestTs || '';
      for (const message of messages) {
        if (!message.ts || message.subtype === 'message_deleted') continue;
        const replies = message.thread_ts ? await this.paginate('conversations.replies', { channel: channelId, ts: message.thread_ts, limit: '200' }, 'messages', scope) : [];
        const permalink = await this.call('chat.getPermalink', { channel: channelId, message_ts: message.ts }, scope).then((data) => data.permalink).catch(() => '');
        const userNames = await this.resolveUserNames([message, ...replies], scope);
        documents.push(slackMessageToDocument({ tenantId, userId, channel: channel.channel, message, replies, permalink, userNames }));
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

  async paginate(method, params, key, scope = {}) {
    const items = [];
    let cursor = '';
    do {
      const data = await this.call(method, cursor ? { ...params, cursor } : params, scope);
      items.push(...(data[key] || []));
      cursor = data.response_metadata?.next_cursor || '';
    } while (cursor);
    return items;
  }

  async discoverMemberChannels(scope = {}) {
    const channels = await this.paginate('conversations.list', {
      exclude_archived: 'true',
      limit: '200',
      types: 'public_channel,private_channel',
    }, 'channels', scope);
    return channels.filter((channel) => channel.is_member).map((channel) => channel.id);
  }

  async eventDocument({ tenantId, userId, event, scope }) {
    const message = normalizeSlackEventMessage(event);
    if (!message?.ts || !event.channel || !message.text) return null;
    const channel = await this.call('conversations.info', { channel: event.channel }, scope)
      .then((data) => data.channel)
      .catch(() => ({ id: event.channel, name: event.channel }));
    const replies = message.thread_ts
      ? await this.paginate('conversations.replies', {
        channel: event.channel,
        ts: message.thread_ts,
        limit: '200',
      }, 'messages', scope)
      : [];
    const permalink = await this.call('chat.getPermalink', {
      channel: event.channel,
      message_ts: message.ts,
    }, scope).then((data) => data.permalink).catch(() => '');
    const userNames = await this.resolveUserNames([message, ...replies], scope);
    return slackMessageToDocument({
      tenantId,
      userId,
      channel,
      message,
      replies,
      permalink,
      userNames,
    });
  }

  async resolveUserNames(messages, scope) {
    const ids = [...new Set(messages.map((message) => message.user).filter(Boolean))];
    await Promise.all(ids.map(async (id) => {
      if (this.userNames.has(id)) return;
      const name = await this.call('users.info', { user: id }, scope)
        .then(({ user }) => user?.profile?.display_name || user?.profile?.real_name || user?.real_name || user?.name || id)
        .catch(() => id);
      this.userNames.set(id, name);
    }));
    return this.userNames;
  }

  async call(method, params, scope = {}) {
    const credentials = this.credentials(scope);
    const response = await fetch(`${SLACK_API_BASE}/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credentials.botToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.error || `Slack ${method} failed`);
    return data;
  }

  credentials(scope = {}) {
    const credentials = this.tokenProvider?.credentialsFor(this.source, scope) || this.config;
    return {
      ...credentials,
      channelIds: Array.isArray(credentials.channelIds) ? credentials.channelIds : list(credentials.channelIds),
    };
  }
}

function list(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function normalizeSlackEventMessage(event = {}) {
  if (event.subtype === 'message_changed') return event.message || null;
  if (event.subtype === 'message_deleted') return null;
  return event;
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

function slackMessageToDocument({ tenantId, userId, channel, message, replies, permalink, userNames = new Map() }) {
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
    author: userNames.get(message.user) || message.username || message.user || message.bot_id || 'unknown',
    timestamp: slackTsToIso(message.ts),
    container: channel.name || channel.id,
    metadata: { channelId: channel.id, channelName: channel.name, messageTs: message.ts, links: extractLinks(text), files },
    children: [
      ...replies.filter((reply) => reply.ts !== message.ts).map((reply) => ({ kind: 'thread_reply', title: userNames.get(reply.user) || reply.username || reply.user || 'reply', text: clean(reply.text || ''), timestamp: slackTsToIso(reply.ts) })),
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
