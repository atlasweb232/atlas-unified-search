import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class LocalArtifactProvider {
  constructor({ dataDir }) {
    this.name = 'local-artifact';
    this.artifactDir = path.join(dataDir, 'artifacts');
  }

  configured() {
    return true;
  }

  async create({ type, title, sections, provenanceResultIds }) {
    await mkdir(this.artifactDir, { recursive: true });
    const extension = type === 'create_powerpoint' ? 'pptx.md' : type === 'create_pdf' ? 'pdf.md' : 'md';
    const artifactId = `artifact_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const filePath = path.join(this.artifactDir, `${artifactId}.${extension}`);
    const body = [
      `# ${title}`,
      '',
      ...sections.flatMap((section) => [`## ${section.heading}`, '', section.body, '']),
      '## Provenance',
      '',
      ...provenanceResultIds.map((id) => `- ${id}`),
    ].join('\n');
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
