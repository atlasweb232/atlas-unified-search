import { google } from 'googleapis';
import { createDocument, oneLine, SOURCES } from '../model.js';

const EXPORT_TYPES = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};

export class GoogleDriveConnector {
  constructor(config) {
    this.source = SOURCES.gdrive;
    this.config = config.gdrive;
    this.practical = true;
    this.description = 'Google Drive connector for file metadata, exported docs, text extraction, and attachment-like files.';
  }

  isConfigured() {
    return Boolean(
      this.config.serviceAccountJson ||
      (this.config.clientId && this.config.clientSecret && this.config.refreshToken),
    );
  }

  requirements() {
    return [
      { name: 'GOOGLE_SERVICE_ACCOUNT_JSON', configured: Boolean(this.config.serviceAccountJson), alternativeGroup: 'google_auth' },
      { name: 'GOOGLE_CLIENT_ID', configured: Boolean(this.config.clientId), alternativeGroup: 'google_auth' },
      { name: 'GOOGLE_CLIENT_SECRET', configured: Boolean(this.config.clientSecret), alternativeGroup: 'google_auth' },
      { name: 'GOOGLE_REFRESH_TOKEN', configured: Boolean(this.config.refreshToken), alternativeGroup: 'google_auth' },
      { name: 'GDRIVE_FOLDER_IDS', configured: Boolean(this.config.folderIds.length), optional: true },
    ];
  }

  async checkReadiness() {
    const drive = google.drive({ version: 'v3', auth: await this.auth() });
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
        folderScoped: Boolean(this.config.folderIds.length),
        configuredFolderCount: this.config.folderIds.length,
      },
    };
  }

  async sync({ tenantId, userId, options = {} }) {
    if (options.fixtures) return options.fixtures.map((item) => driveFixtureToDocument({ tenantId, userId, item }));
    if (!this.isConfigured()) throw new Error('Google Drive connector is not configured');
    const drive = google.drive({ version: 'v3', auth: await this.auth() });
    const files = await this.listFiles(drive, options);
    const documents = [];
    for (const file of files) {
      const extracted = await this.extractText(drive, file).catch((error) => ({ text: '', error: error.message }));
      documents.push(driveFileToDocument({ tenantId, userId, file, extracted }));
    }
    return documents;
  }

  async auth() {
    if (this.config.serviceAccountJson) {
      const credentials = JSON.parse(this.config.serviceAccountJson);
      return new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/drive.readonly'],
      });
    }
    const oauth2Client = new google.auth.OAuth2(this.config.clientId, this.config.clientSecret);
    oauth2Client.setCredentials({ refresh_token: this.config.refreshToken });
    return oauth2Client;
  }

  async listFiles(drive, options) {
    const folderIds = options.folderIds?.length ? options.folderIds : this.config.folderIds;
    const folderQuery = folderIds.length
      ? ` and (${folderIds.map((id) => `'${id}' in parents`).join(' or ')})`
      : '';
    const response = await drive.files.list({
      q: `trashed=false${folderQuery}`,
      pageSize: options.limit || this.config.limit,
      fields: 'files(id,name,mimeType,modifiedTime,webViewLink,owners(displayName,emailAddress),parents,size)',
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
