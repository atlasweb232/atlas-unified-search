import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BlobServiceClient } from '@azure/storage-blob';

export class LocalArtifactProvider {
  constructor({ dataDir, azure = {} }) {
    this.azure = azure;
    this.name = azure.azureStorageConnectionString ? 'azure-blob-artifact' : 'local-artifact';
    this.artifactDir = path.join(dataDir, 'artifacts');
    this.blobClient = azure.azureStorageConnectionString
      ? BlobServiceClient.fromConnectionString(azure.azureStorageConnectionString)
      : null;
  }

  configured() {
    return this.name === 'local-artifact' || Boolean(this.azure.container);
  }

  async create({ type, title, sections, provenanceResultIds }) {
    const extension = type === 'create_powerpoint' ? 'pptx.md' : type === 'create_pdf' ? 'pdf.md' : 'md';
    const artifactId = `artifact_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const body = [
      `# ${title}`,
      '',
      ...sections.flatMap((section) => [`## ${section.heading}`, '', section.body, '']),
      '## Provenance',
      '',
      ...provenanceResultIds.map((id) => `- ${id}`),
    ].join('\n');
    if (this.blobClient) {
      const container = this.blobClient.getContainerClient(this.azure.container);
      await container.createIfNotExists();
      const blobName = `${artifactId}.${extension}`;
      const blob = container.getBlockBlobClient(blobName);
      await blob.upload(body, Buffer.byteLength(body), {
        blobHTTPHeaders: { blobContentType: 'text/markdown' },
      });
      return {
        artifactId,
        storageUri: blob.url,
        downloadUrl: this.azure.publicBaseUrl ? `${this.azure.publicBaseUrl.replace(/\/$/, '')}/${blobName}` : blob.url,
        mimeType: 'text/markdown',
        size: Buffer.byteLength(body),
      };
    }
    await mkdir(this.artifactDir, { recursive: true });
    const filePath = path.join(this.artifactDir, `${artifactId}.${extension}`);
    await writeFile(filePath, body);
    return {
      artifactId,
      storageUri: filePath,
      downloadUrl: '',
      mimeType: 'text/markdown',
      size: Buffer.byteLength(body),
    };
  }
}
