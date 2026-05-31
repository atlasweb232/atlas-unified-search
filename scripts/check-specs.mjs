import { access, readFile } from 'node:fs/promises';

const requiredFiles = [
  'README.md',
  'specs/001-unified-knowledge-search/spec.md',
  'specs/001-unified-knowledge-search/plan.md',
  'specs/001-unified-knowledge-search/tasks.md',
  'specs/001-unified-knowledge-search/data-model.md',
  'specs/001-unified-knowledge-search/research.md',
  'specs/001-unified-knowledge-search/quickstart.md',
  'specs/001-unified-knowledge-search/contracts/unified-search-api.yaml',
  'specs/001-unified-knowledge-search/checklists/requirements.md',
  'docs/source-references.md',
];

for (const file of requiredFiles) {
  await access(file);
  const content = await readFile(file, 'utf8');
  if (!content.trim()) throw new Error(`${file} is empty`);
}

const spec = await readFile('specs/001-unified-knowledge-search/spec.md', 'utf8');
for (const term of ['Slack', 'Google Drive', 'Conference', 'Email', 'tenantId', 'userId']) {
  if (!spec.includes(term)) throw new Error(`spec missing ${term}`);
}

console.log('spec check ok');
