const baseUrl = (process.env.UNIFIED_SEARCH_BASE_URL || 'https://atlas-unified-search.proudfield-a201b3fd.eastus.azurecontainerapps.io').replace(/\/$/, '');
const appName = process.env.SLACK_APP_NAME || 'Atlas Unified Search';
const shortName = process.env.SLACK_APP_SHORT_NAME || 'atlas-search';
const description = process.env.SLACK_APP_DESCRIPTION || 'Indexes selected Slack conversations into the backend-owned Atlas unified search pipeline.';

const manifest = {
  display_information: {
    name: appName,
    description,
    background_color: '#1f2937',
  },
  features: {
    bot_user: {
      display_name: shortName,
      always_online: false,
    },
  },
  oauth_config: {
    scopes: {
      bot: [
        'channels:history',
        'channels:read',
        'files:read',
        'groups:history',
        'groups:read',
        'im:history',
        'mpim:history',
        'users:read',
      ],
    },
  },
  settings: {
    event_subscriptions: {
      request_url: `${baseUrl}/v1/webhooks/slack/events`,
      bot_events: [
        'file_shared',
        'message.channels',
        'message.groups',
      ],
    },
    interactivity: {
      is_enabled: false,
    },
    org_deploy_enabled: false,
    socket_mode_enabled: false,
    token_rotation_enabled: false,
  },
};

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  requestUrl: manifest.settings.event_subscriptions.request_url,
  nextSteps: [
    'Create a Slack app from this manifest at https://api.slack.com/apps.',
    'Install the app into the workspace.',
    'Invite the bot to private channels that should be indexed.',
    'Store the bot token as SLACK_BOT_TOKEN and the signing secret as SLACK_SIGNING_SECRET.',
    'Run npm run slack:list-channels, then set SLACK_CHANNEL_IDS to the selected channel IDs.',
    'Run VALIDATE_CONNECTOR_SOURCES=slack VALIDATE_CONNECTOR_REQUIRE_CONFIG=true npm run validate:connector-credentials before wiring Azure.',
  ],
  manifest,
}, null, 2));
