import { loadConfig } from '../src/config.js';
import { SlackConnector } from '../src/connectors/slack.js';

const config = loadConfig();
const connector = new SlackConnector(config);
const limit = positiveInt(process.env.SLACK_CHANNEL_LIST_LIMIT, 200);
const includePrivate = truthy(process.env.SLACK_CHANNEL_LIST_PRIVATE ?? 'true');
const includeArchived = truthy(process.env.SLACK_CHANNEL_LIST_ARCHIVED);
const includeUnjoined = truthy(process.env.SLACK_CHANNEL_LIST_UNJOINED);

if (!config.slack.botToken) {
  fail('SLACK_BOT_TOKEN is required to list Slack channels.');
}

const types = ['public_channel', ...(includePrivate ? ['private_channel'] : [])].join(',');
const channels = [];
let cursor = '';

do {
  const response = await connector.call('conversations.list', {
    types,
    limit: String(Math.min(limit, 1000)),
    exclude_archived: includeArchived ? 'false' : 'true',
    ...(cursor ? { cursor } : {}),
  });
  channels.push(...(response.channels || []));
  cursor = response.response_metadata?.next_cursor || '';
} while (cursor && channels.length < limit);

const selected = channels
  .filter((channel) => includeUnjoined || channel.is_member)
  .slice(0, limit)
  .map((channel) => ({
    id: channel.id,
    name: channel.name,
    private: Boolean(channel.is_private),
    member: Boolean(channel.is_member),
    archived: Boolean(channel.is_archived),
    members: channel.num_members,
  }));

const configuredIds = new Set(config.slack.channelIds);
const report = {
  generatedAt: new Date().toISOString(),
  listed: selected.length,
  configuredChannelIds: config.slack.channelIds,
  configuredChannelsVisible: selected
    .filter((channel) => configuredIds.has(channel.id))
    .map((channel) => ({ id: channel.id, name: channel.name, member: channel.member })),
  channels: selected,
  next: [
    'Set SLACK_CHANNEL_IDS to the comma-separated channel IDs that should be indexed.',
    'Invite the bot to private channels before expecting private channel history to pass validation.',
    'Run VALIDATE_CONNECTOR_SOURCES=slack VALIDATE_CONNECTOR_REQUIRE_CONFIG=true npm run validate:connector-credentials before wiring Azure.',
  ],
};

console.log(JSON.stringify(report, null, 2));

function truthy(value) {
  return ['1', 'true', 'yes'].includes(String(value || '').toLowerCase());
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function fail(message) {
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(1);
}
