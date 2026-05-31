import assert from 'node:assert/strict';
import test from 'node:test';
import { createChunks, createDocument, SOURCES } from '../src/model.js';

test('createDocument requires tenant/user/source/sourceId and chunks children', () => {
  const document = createDocument({
    tenantId: 'tenant',
    userId: 'user',
    source: SOURCES.slack,
    sourceId: 'C1:1',
    title: 'Incident thread',
    body: 'Deployment failed because a variable was missing.',
    children: [{ kind: 'thread_reply', title: 'Reply', text: 'Rollback completed.' }],
  });

  const chunks = createChunks(document);
  assert.equal(document.id, 'tenant:user:slack:C1:1');
  assert.equal(chunks.length, 2);
  assert.equal(chunks[1].metadata.kind, 'thread_reply');
});
