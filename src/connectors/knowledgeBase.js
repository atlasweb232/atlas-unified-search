import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createDocument, oneLine, SOURCES } from '../model.js';

export class KnowledgeBaseConnector {
  constructor(config) {
    this.source = SOURCES.knowledgeBase;
    this.config = config.knowledgeBase;
    this.practical = false;
    this.description = 'Knowledge base connector for local markdown/text roots; future CMS/wiki adapters fit here.';
  }

  isConfigured() {
    return Boolean(this.config.root);
  }

  async sync({ tenantId, userId, options = {} }) {
    if (options.fixtures) return options.fixtures.map((item) => kbFixtureToDocument({ tenantId, userId, item }));
    if (!this.isConfigured()) throw new Error('Knowledge base connector is not configured');
    const files = await walk(this.config.root);
    const documents = [];
    for (const file of files.filter((name) => /\.(md|txt)$/i.test(name))) {
      const text = await readFile(file, 'utf8');
      documents.push(kbFixtureToDocument({ tenantId, userId, item: { path: file, title: path.basename(file), text } }));
    }
    return documents;
  }
}

function kbFixtureToDocument({ tenantId, userId, item }) {
  return createDocument({
    tenantId,
    userId,
    source: SOURCES.knowledgeBase,
    sourceId: item.id || item.path || item.title,
    sourceUri: item.path || '',
    title: item.title,
    summary: item.summary || oneLine(item.text),
    body: item.text || '',
    author: item.author || 'knowledge-base',
    timestamp: item.timestamp || new Date().toISOString(),
    container: item.space || 'knowledge-base',
    metadata: item.metadata || {},
  });
}

async function walk(root) {
  const entries = await readdir(root);
  const files = [];
  for (const entry of entries) {
    const full = path.join(root, entry);
    const info = await stat(full);
    if (info.isDirectory()) files.push(...await walk(full));
    else files.push(full);
  }
  return files;
}
