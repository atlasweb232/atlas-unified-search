const SOURCE_ENV_KEYS = {
  slack: ['botToken', 'channelIds'],
  google_drive: ['clientId', 'clientSecret', 'refreshToken', 'serviceAccountJson', 'folderIds'],
};

export class ConnectorTokenProvider {
  constructor({ staticTokens = {}, envFallback = {}, dynamicResolver = null } = {}) {
    this.staticTokens = normalizeStaticTokens(staticTokens);
    this.envFallback = envFallback;
    // Optional runtime resolver (e.g. the onboarding store): (source, scope) =>
    // credentials. Runtime-connected credentials take precedence over static/env.
    this.dynamicResolver = typeof dynamicResolver === 'function' ? dynamicResolver : null;
  }

  credentialsFor(source, { tenantId = '', userId = '' } = {}) {
    const scoped = this.staticTokens[scopeKey(tenantId, userId)]?.[source]
      || this.staticTokens[scopeKey(tenantId, '*')]?.[source]
      || this.staticTokens[scopeKey('*', userId)]?.[source]
      || this.staticTokens['*:*']?.[source]
      || {};
    const dynamic = this.dynamicResolver
      ? normalizeCredentials(this.dynamicResolver(source, { tenantId, userId }) || {})
      : {};
    return pruneEmpty({
      ...(this.envFallback[source] || {}),
      ...normalizeCredentials(scoped),
      ...dynamic,
    });
  }

  hasScopedCredentials(source, scope = {}) {
    return Object.keys(this.credentialsFor(source, scope)).length > 0;
  }

  requirements(source, scope = {}, baseRequirements = []) {
    const credentials = this.credentialsFor(source, scope);
    const scoped = this.hasScopedCredentials(source, scope);
    const keys = SOURCE_ENV_KEYS[source] || [];
    return baseRequirements.map((requirement) => {
      const credentialKey = keys.find((key) => envNameFor(key) === requirement.name) || '';
      const configured = credentialKey ? hasValue(credentials[credentialKey]) : requirement.configured;
      return {
        ...requirement,
        configured,
        source: scoped ? 'token_provider_or_env' : requirement.source || 'env',
      };
    });
  }
}

export function createConnectorTokenProvider(config, { dynamicResolver = null } = {}) {
  return new ConnectorTokenProvider({
    staticTokens: config.connectorTokens || {},
    envFallback: {
      slack: config.slack,
      google_drive: config.gdrive,
    },
    dynamicResolver,
  });
}

function normalizeStaticTokens(value) {
  if (!value || typeof value !== 'object') return {};
  const scopes = value.scopes && typeof value.scopes === 'object' ? value.scopes : value;
  return Object.fromEntries(Object.entries(scopes).map(([scope, sources]) => [
    scope,
    Object.fromEntries(Object.entries(sources || {}).map(([source, credentials]) => [source, normalizeCredentials(credentials)])),
  ]));
}

function scopeKey(tenantId, userId) {
  return `${tenantId || '*'}:${userId || '*'}`;
}

function envNameFor(key) {
  const names = {
    botToken: 'SLACK_BOT_TOKEN',
    channelIds: 'SLACK_CHANNEL_IDS',
    clientId: 'GOOGLE_CLIENT_ID',
    clientSecret: 'GOOGLE_CLIENT_SECRET',
    refreshToken: 'GOOGLE_REFRESH_TOKEN',
    serviceAccountJson: 'GOOGLE_SERVICE_ACCOUNT_JSON',
    folderIds: 'GDRIVE_FOLDER_IDS',
  };
  return names[key] || key;
}

function normalizeCredentials(credentials = {}) {
  return pruneEmpty({
    ...credentials,
    botToken: credentials.botToken || credentials.SLACK_BOT_TOKEN,
    channelIds: credentials.channelIds || credentials.SLACK_CHANNEL_IDS,
    clientId: credentials.clientId || credentials.GOOGLE_CLIENT_ID,
    clientSecret: credentials.clientSecret || credentials.GOOGLE_CLIENT_SECRET,
    refreshToken: credentials.refreshToken || credentials.GOOGLE_REFRESH_TOKEN,
    serviceAccountJson: credentials.serviceAccountJson || credentials.GOOGLE_SERVICE_ACCOUNT_JSON,
    folderIds: credentials.folderIds || credentials.GDRIVE_FOLDER_IDS,
  });
}

function pruneEmpty(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => hasValue(entry)));
}

function hasValue(value) {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}
