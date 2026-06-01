import { google } from 'googleapis';
import { createDocument, oneLine, SOURCES } from '../model.js';
import { checkpointKey } from './base.js';

const EXPORT_TYPES = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};

export class GoogleDriveConnector {
  constructor(config, tokenProvider = null) {
    this.source = SOURCES.gdrive;
    this.config = config.gdrive;
    this.tokenProvider = tokenProvider;
    this.practical = true;
    this.description = 'Google Drive connector for file metadata, exported docs, text extraction, and attachment-like files.';
  }

  isConfigured(scope = {}) {
    const credentials = this.credentials(scope);
    return Boolean(
      credentials.serviceAccountJson ||
      (credentials.clientId && credentials.clientSecret && credentials.refreshToken),
    );
  }

  requirements(scope = {}) {
    const credentials = this.credentials(scope);
    const requirements = [
      { name: 'GOOGLE_SERVICE_ACCOUNT_JSON', configured: Boolean(this.config.serviceAccountJson), alternativeGroup: 'google_auth' },
      { name: 'GOOGLE_CLIENT_ID', configured: Boolean(this.config.clientId), alternativeGroup: 'google_auth' },
      { name: 'GOOGLE_CLIENT_SECRET', configured: Boolean(this.config.clientSecret), alternativeGroup: 'google_auth' },
      { name: 'GOOGLE_REFRESH_TOKEN', configured: Boolean(this.config.refreshToken), alternativeGroup: 'google_auth' },
      { name: 'GDRIVE_FOLDER_IDS', configured: Boolean(this.config.folderIds.length), optional: true },
    ];
    if (this.tokenProvider) return this.tokenProvider.requirements(this.source, scope, requirements);
    return requirements.map((requirement) => ({
      ...requirement,
      configured: configuredForRequirement(requirement.name, credentials),
    }));
  }

  async checkReadiness(scope = {}) {
    const credentials = this.credentials(scope);
    const drive = google.drive({ version: 'v3', auth: await this.auth(scope) });
    const response = await drive.files.list({
      q: 'trashed=false',
      pageSize: 1,
      fields: 'files(id,name,mimeType),nextPageToken',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    return {
      ready: true,
      status: 'ok',
      details: {
        sampleFileVisible: Boolean(response.data.files?.length),
        folderScoped: Boolean(credentials.folderIds.length),
        configuredFolderCount: credentials.folderIds.length,
      },
    };
  }

  async sync({ tenantId, userId, store, options = {} }) {
    if (options.fixtures) return options.fixtures.map((item) => driveFixtureToDocument({ tenantId, userId, item }));
    const scope = { tenantId, userId };
    if (!this.isConfigured(scope)) throw new Error('Google Drive connector is not configured');
    const credentials = this.credentials(scope);
    const drive = google.drive({ version: 'v3', auth: await this.auth(scope) });
    const folderIds = options.folderIds?.length ? options.folderIds : credentials.folderIds;
    const checkpointName = `files:${folderIds.length ? folderIds.join(',') : 'all'}`;
    const key = checkpointKey(this.source, tenantId, userId, checkpointName);
    const checkpoint = options.forceFullSync ? null : store?.getCheckpoint(key);
    const modifiedAfter = options.modifiedAfter || checkpoint?.latestModifiedTime || '';
    const files = await this.listFiles(drive, { ...options, credentials, folderIds, modifiedAfter });
    const documents = [];
    let latestModifiedTime = checkpoint?.latestModifiedTime || '';
    for (const file of files) {
      const extracted = await this.extractText(drive, file).catch((error) => ({ text: '', error: error.message }));
      documents.push(driveFileToDocument({ tenantId, userId, file, extracted }));
      if (isAfter(file.modifiedTime, latestModifiedTime)) latestModifiedTime = file.modifiedTime;
    }
    if (store && latestModifiedTime) {
      store.setCheckpoint(key, {
        source: this.source,
        folderIds,
        latestModifiedTime,
        lastSyncedAt: new Date().toISOString(),
        syncedFiles: files.length,
      });
    }
    return documents;
  }

  async auth(scope = {}) {
    const credentials = this.credentials(scope);
    if (credentials.serviceAccountJson) {
      const serviceAccount = JSON.parse(credentials.serviceAccountJson);
      return new google.auth.GoogleAuth({
        credentials: serviceAccount,
        scopes: ['https://www.googleapis.com/auth/drive.readonly'],
      });
    }
    const oauth2Client = new google.auth.OAuth2(credentials.clientId, credentials.clientSecret);
    oauth2Client.setCredentials({ refresh_token: credentials.refreshToken });
    return oauth2Client;
  }

  async listFiles(drive, options) {
    const folderIds = options.folderIds?.length ? options.folderIds : options.credentials?.folderIds || this.credentials({}).folderIds;
    const folderQuery = folderIds.length
      ? ` and (${folderIds.map((id) => `'${id}' in parents`).join(' or ')})`
      : '';
    const modifiedQuery = options.modifiedAfter ? ` and modifiedTime > '${escapeDriveQueryValue(options.modifiedAfter)}'` : '';
    const response = await drive.files.list({
      q: `trashed=false${folderQuery}${modifiedQuery}`,
      pageSize: options.limit || this.config.limit,
      fields: 'files(id,name,mimeType,modifiedTime,webViewLink,owners(displayName,emailAddress),parents,size)',
      orderBy: 'modifiedTime asc',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    return response.data.files || [];
  }

  async extractText(drive, file) {
    if (EXPORT_TYPES[file.mimeType]) {
      const response = await drive.files.export(
        { fileId: file.id, mimeType: EXPORT_TYPES[file.mimeType] },
        { responseType: 'text' },
      );
      return { text: String(response.data || ''), exportMimeType: EXPORT_TYPES[file.mimeType] };
    }
    if (/text|json|csv|xml|markdown/.test(file.mimeType || '')) {
      const response = await drive.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'text' });
      return { text: String(response.data || ''), exportMimeType: file.mimeType };
    }
    return { text: '', exportMimeType: '', skipped: 'binary_or_unsupported' };
  }

  credentials(scope = {}) {
    const credentials = this.tokenProvider?.credentialsFor(this.source, scope) || this.config;
    return {
      ...credentials,
      folderIds: Array.isArray(credentials.folderIds) ? credentials.folderIds : list(credentials.folderIds),
    };
  }
}

function configuredForRequirement(name, credentials) {
  const values = {
    GOOGLE_SERVICE_ACCOUNT_JSON: credentials.serviceAccountJson,
    GOOGLE_CLIENT_ID: credentials.clientId,
    GOOGLE_CLIENT_SECRET: credentials.clientSecret,
    GOOGLE_REFRESH_TOKEN: credentials.refreshToken,
    GDRIVE_FOLDER_IDS: credentials.folderIds,
  };
  const value = values[name];
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

function list(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function isAfter(left, right) {
  if (!left) return false;
  if (!right) return true;
  return new Date(left).getTime() > new Date(right).getTime();
}

function escapeDriveQueryValue(value) {
  return String(value || '').replace(/'/g, "\\'");
}

function driveFixtureToDocument({ tenantId, userId, item }) {
  return createDocument({
    tenantId,
    userId,
    source: SOURCES.gdrive,
    sourceId: item.fileId || item.sourceId,
    sourceUri: item.webViewLink || '',
    title: item.name || item.title,
    summary: item.summary || oneLine(item.text),
    body: item.text || '',
    author: item.owner || '',
    timestamp: item.modifiedTime || new Date().toISOString(),
    container: item.folderPath || 'Drive',
    metadata: { fileId: item.fileId, mimeType: item.mimeType, webViewLink: item.webViewLink, folderPath: item.folderPath },
    children: (item.attachments || []).map((attachment) => ({ kind: 'attachment', title: attachment.name, text: attachment.text || attachment.name, metadata: attachment })),
  });
}

function driveFileToDocument({ tenantId, userId, file, extracted }) {
  const owner = file.owners?.[0]?.displayName || file.owners?.[0]?.emailAddress || '';
  return createDocument({
    tenantId,
    userId,
    source: SOURCES.gdrive,
    sourceId: file.id,
    sourceUri: file.webViewLink || '',
    title: file.name,
    summary: oneLine(extracted.text || `${file.name} ${file.mimeType}`),
    body: extracted.text || '',
    author: owner,
    timestamp: file.modifiedTime || new Date().toISOString(),
    container: file.parents?.[0] || 'Drive',
    metadata: {
      fileId: file.id,
      mimeType: file.mimeType,
      webViewLink: file.webViewLink,
      owners: file.owners || [],
      size: file.size || null,
      extraction: extracted,
    },
    children: [{
      kind: 'attachment',
      title: file.name,
      text: extracted.text || file.name,
      metadata: { fileId: file.id, mimeType: file.mimeType, size: file.size || null },
    }],
  });
}
