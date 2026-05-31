import dotenv from 'dotenv';

dotenv.config();

function list(name) {
  return String(process.env[name] || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function number(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function json(name, fallback) {
  const value = process.env[name];
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function loadConfig() {
  const authToken = process.env.UNIFIED_SEARCH_AUTH_TOKEN || '';
  const requireAuth = ['1', 'true', 'yes'].includes(String(process.env.UNIFIED_SEARCH_REQUIRE_AUTH || '').toLowerCase()) || Boolean(authToken);
  return {
    port: number('PORT', 4420),
    dataDir: process.env.DATA_DIR || '.data',
    embeddingProvider: process.env.EMBEDDING_PROVIDER || 'hash',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    embeddingModel: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
    chat: {
      provider: process.env.CHAT_PROVIDER || '',
      model: process.env.CHAT_MODEL || '',
      openaiApiKey: process.env.OPENAI_API_KEY || '',
      openaiBaseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      azureOpenaiApiKey: process.env.AZURE_OPENAI_API_KEY || '',
      azureOpenaiEndpoint: process.env.AZURE_OPENAI_ENDPOINT || '',
      azureOpenaiDeployment: process.env.AZURE_OPENAI_DEPLOYMENT || '',
      azureOpenaiApiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-06-01',
      anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
      anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
      cerebrasApiKey: process.env.CEREBRAS_API_KEY || '',
      cerebrasBaseUrl: process.env.CEREBRAS_BASE_URL || 'https://api.cerebras.ai/v1',
    },
    auth: {
      required: requireAuth,
      token: authToken,
    },
    sourcePermissions: json('UNIFIED_SEARCH_SOURCE_PERMISSIONS', {}),
    postgres: {
      connectionString: process.env.POSTGRES_CONNECTION_STRING || '',
      ssl: !['0', 'false', 'no'].includes(String(process.env.POSTGRES_SSL || 'true').toLowerCase()),
    },
    serviceBus: {
      connectionString: process.env.SERVICE_BUS_CONNECTION_STRING || '',
      syncQueueName: process.env.SERVICE_BUS_SYNC_QUEUE_NAME || 'unified-search-sync',
    },
    artifacts: {
      azureStorageConnectionString: process.env.ARTIFACT_STORAGE_CONNECTION_STRING || process.env.AZURE_STORAGE_CONNECTION_STRING || '',
      container: process.env.ARTIFACT_BLOB_CONTAINER || 'unified-search-artifacts',
      publicBaseUrl: process.env.ARTIFACT_PUBLIC_BASE_URL || '',
    },
    slack: {
      botToken: process.env.SLACK_BOT_TOKEN || '',
      channelIds: list('SLACK_CHANNEL_IDS'),
      limit: number('SLACK_SYNC_LIMIT', 50),
    },
    gdrive: {
      clientId: process.env.GOOGLE_CLIENT_ID || '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
      refreshToken: process.env.GOOGLE_REFRESH_TOKEN || '',
      serviceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '',
      folderIds: list('GDRIVE_FOLDER_IDS'),
      limit: number('GDRIVE_SYNC_LIMIT', 50),
    },
    email: {
      baseUrl: process.env.EMAIL_CONNECTOR_BASE_URL || '',
      searchUrl: process.env.EMAIL_VECTOR_SEARCH_URL || '',
      apiToken: process.env.EMAIL_CONNECTOR_API_TOKEN || '',
      readinessUserEmail: process.env.EMAIL_READINESS_USER_EMAIL || '',
      sessionId: process.env.EMAIL_CONNECTOR_SESSION_ID || '',
      limit: number('EMAIL_CONNECTOR_LIMIT', 50),
    },
    conference: {
      azureStorageConnectionString: process.env.AZURE_STORAGE_CONNECTION_STRING || '',
      containers: list('CONFERENCE_BLOB_CONTAINERS'),
    },
    knowledgeBase: {
      root: process.env.KNOWLEDGE_BASE_ROOT || '',
    },
    dataFabric: {
      baseUrl: process.env.DATA_FABRIC_BASE_URL || '',
      apiToken: process.env.DATA_FABRIC_API_TOKEN || '',
      readinessPath: process.env.DATA_FABRIC_READINESS_PATH || '/health',
      recordsPath: process.env.DATA_FABRIC_RECORDS_PATH || '/records',
    },
  };
}
