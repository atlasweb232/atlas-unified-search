import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workspacePath = new URL('../frontend/src/UnifiedSearchWorkspace.jsx', import.meta.url);
const mainPath = new URL('../frontend/src/main.jsx', import.meta.url);
const storePath = new URL('../src/store.js', import.meta.url);

test('connector UI uses source tiles, popup OAuth, and vector activity', async () => {
  const workspace = await readFile(workspacePath, 'utf8');

  for (const source of ['email', 'slack', 'google_drive', 'conference_bridge', 'knowledge_base', 'data_fabric']) {
    assert.match(workspace, new RegExp(`['"]${source}['"]`));
  }
  assert.match(workspace, /connector-button-\$\{source\}/);
  assert.match(workspace, /window\.open\(/);
  assert.match(workspace, /atlas-unified-search-oauth/);
  assert.match(workspace, /Vectorization Activity/);
  assert.match(workspace, /\/v1\/index\/status/);
  assert.match(workspace, /\/v1\/jobs/);
  assert.match(workspace, /\/v1\/audit/);
});

test('OAuth callback hands credentials to its opener and preserves the workspace', async () => {
  const main = await readFile(mainPath, 'utf8');

  assert.match(main, /window\.opener\.postMessage/);
  assert.match(main, /window\.close\(\)/);
  assert.match(main, /window\.history\.replaceState/);
});

test('search results expose full message text and summarize all retrieved results', async () => {
  const [workspace, store] = await Promise.all([
    readFile(workspacePath, 'utf8'),
    readFile(storePath, 'utf8'),
  ]);

  assert.match(store, /body: document\.body \|\| ''/);
  assert.match(workspace, /displayValue\(result\.body\)/);
  assert.match(workspace, /formatRelevance\(result\.score\)/);
  assert.match(workspace, /results\.map\(\(result\) => result\.id\)/);
  assert.match(workspace, /Retrieval summary/);
});
