import { BlobServiceClient } from '@azure/storage-blob';
import { createDocument, oneLine, SOURCES } from '../model.js';

export class ConferenceBridgeConnector {
  constructor(config) {
    this.source = SOURCES.conference;
    this.config = config.conference;
    this.practical = true;
    this.description = 'Conference bridge transcript/recording connector over Azure Blob Storage.';
  }

  isConfigured() {
    return Boolean(this.config.azureStorageConnectionString && this.config.containers.length);
  }

  requirements() {
    return [
      { name: 'AZURE_STORAGE_CONNECTION_STRING', configured: Boolean(this.config.azureStorageConnectionString) },
      { name: 'CONFERENCE_BLOB_CONTAINERS', configured: Boolean(this.config.containers.length) },
    ];
  }

  async checkReadiness() {
    const service = BlobServiceClient.fromConnectionString(this.config.azureStorageConnectionString);
    const containers = [];
    for (const containerName of this.config.containers.slice(0, 5)) {
      const container = service.getContainerClient(containerName);
      const exists = await container.exists();
      let sampleBlob = '';
      if (exists) {
        for await (const blob of container.listBlobsFlat().byPage({ maxPageSize: 1 })) {
          sampleBlob = blob.segment.blobItems?.[0]?.name || '';
          break;
        }
      }
      containers.push({ name: containerName, exists, sampleBlob });
    }
    return {
      ready: containers.every((container) => container.exists),
      status: containers.every((container) => container.exists) ? 'ok' : 'container_missing',
      details: { containers },
    };
  }

  async sync({ tenantId, userId, options = {} }) {
    if (options.fixtures) return options.fixtures.map((item) => conferenceFixtureToDocument({ tenantId, userId, item }));
    if (!this.isConfigured()) throw new Error('Conference bridge connector is not configured');
    const service = BlobServiceClient.fromConnectionString(this.config.azureStorageConnectionString);
    const documents = [];
    for (const containerName of this.config.containers) {
      const container = service.getContainerClient(containerName);
      for await (const blob of container.listBlobsFlat({ prefix: options.prefix || '' })) {
        if (!/\.(txt|json|vtt|srt)$/i.test(blob.name)) continue;
        const client = container.getBlobClient(blob.name);
        const text = await client.downloadToBuffer().then((buffer) => buffer.toString('utf8'));
        documents.push(conferenceFixtureToDocument({
          tenantId,
          userId,
          item: { blobName: blob.name, container: containerName, text, timestamp: blob.properties.lastModified?.toISOString(), etag: blob.properties.etag },
        }));
      }
    }
    return documents;
  }
}

function conferenceFixtureToDocument({ tenantId, userId, item }) {
  return createDocument({
    tenantId,
    userId,
    source: SOURCES.conference,
    sourceId: item.meetingId || `${item.container}:${item.blobName}`,
    sourceUri: `azure-blob://${item.container}/${item.blobName}`,
    title: item.title || item.meetingId || item.blobName,
    summary: item.summary || oneLine(item.text),
    body: item.text || '',
    author: item.organizer || '',
    timestamp: item.timestamp || new Date().toISOString(),
    container: item.container || 'conference',
    metadata: { meetingId: item.meetingId, bridgeId: item.bridgeId, participants: item.participants || [], blobName: item.blobName, etag: item.etag },
    children: (item.segments || []).map((segment) => ({ kind: 'transcript_segment', title: segment.speaker, text: segment.text, timestamp: segment.startTime, metadata: segment })),
  });
}
