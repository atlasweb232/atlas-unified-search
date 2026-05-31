export const SOURCES = Object.freeze({
  slack: 'slack',
  gdrive: 'google_drive',
  conference: 'conference_bridge',
  email: 'email',
  knowledgeBase: 'knowledge_base',
  dataFabric: 'data_fabric',
});

export function createDocument({
  tenantId,
  userId,
  source,
  sourceId,
  sourceUri = '',
  title,
  summary = '',
  body = '',
  author = '',
  timestamp,
  container = '',
  access = {},
  metadata = {},
  children = [],
}) {
  if (!tenantId || !userId || !source || !sourceId) {
    throw new Error('tenantId, userId, source, and sourceId are required');
  }
  const now = new Date().toISOString();
  return {
    id: `${tenantId}:${userId}:${source}:${sourceId}`,
    tenantId,
    userId,
    source,
    sourceId,
    sourceUri,
    title: title || summary || sourceId,
    summary: summary || oneLine(body || title || sourceId),
    body,
    author,
    timestamp: timestamp || now,
    container,
    access,
    metadata,
    children,
    createdAt: now,
    updatedAt: now,
  };
}

export function createChunks(document, { maxChars = 1600 } = {}) {
  const chunks = [];
  const baseText = [document.title, document.summary, document.body].filter(Boolean).join('\n\n');
  for (const [index, text] of splitText(baseText, maxChars).entries()) {
    chunks.push(chunk(document, index, text, { kind: 'document' }));
  }
  for (const child of document.children || []) {
    const childText = [child.title, child.summary, child.text, child.body].filter(Boolean).join('\n\n');
    for (const [offset, text] of splitText(childText, maxChars).entries()) {
      chunks.push(chunk(document, chunks.length, text, { kind: child.kind || 'child', childIndex: offset, childId: child.id || '' }));
    }
  }
  return chunks;
}

export function oneLine(text, limit = 180) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1).trim()}…`;
}

function chunk(document, index, text, metadata) {
  return {
    id: `${document.id}:chunk:${index}`,
    documentId: document.id,
    tenantId: document.tenantId,
    userId: document.userId,
    source: document.source,
    chunkIndex: index,
    text,
    summary: oneLine(text, 220),
    embedding: [],
    embeddingModel: '',
    embeddingVersion: '',
    metadata: { ...document.metadata, ...metadata },
    createdAt: new Date().toISOString(),
  };
}

function splitText(text, maxChars) {
  const clean = String(text || '').trim();
  if (!clean) return [];
  const paragraphs = clean.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const chunks = [];
  let current = '';
  for (const paragraph of paragraphs.length ? paragraphs : [clean]) {
    if ((current + '\n\n' + paragraph).length > maxChars && current) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current) chunks.push(current);
  return chunks.flatMap((value) => {
    if (value.length <= maxChars) return [value];
    const parts = [];
    for (let index = 0; index < value.length; index += maxChars) {
      parts.push(value.slice(index, index + maxChars));
    }
    return parts;
  });
}
