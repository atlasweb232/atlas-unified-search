# Quickstart: Monorepo Dev Setup

After `006` is implemented the local dev workflow becomes:

## Install all packages

```bash
npm install   # installs root + all packages/* via workspaces
```

## Run tests

```bash
npm test                    # root: spec check + integration tests
npm run test:packages       # all packages in isolation
npm run test:all            # both

# Single package:
cd packages/embedding && npm test
cd packages/store     && npm test
```

## Swap a provider (the point of this spec)

No code change — only env vars:

```bash
# Swap text embedder: hash (default/offline) ↔ OpenAI
EMBEDDING_PROVIDER=openai OPENAI_API_KEY=sk-... npm start

# Swap vector store: JSON (dev) ↔ pgvector (prod)
POSTGRES_CONNECTION_STRING=postgres://... npm start

# Swap queue: inline (dev) ↔ Service Bus (prod) ↔ BullMQ (local Redis)
SERVICE_BUS_CONNECTION_STRING=... npm start
BULLMQ_REDIS_URL=redis://localhost:6379 npm start

# Swap chat provider
CHAT_PROVIDER=anthropic ANTHROPIC_API_KEY=... npm start
CHAT_PROVIDER=mock npm start   # no key needed

# Swap artifact provider
ARTIFACT_PROVIDER=organic npm start   # no key needed (default)
ARTIFACT_PROVIDER=llm npm start       # uses CHAT_PROVIDER
```

## Add a new provider (how to extend)

1. Create a file in the relevant package that implements the interface:
   ```
   packages/embedding/src/text/my-provider.js
   ```
2. Export it from the package `index.js`.
3. Add a branch to the factory function:
   ```js
   if (config.embeddingProvider === 'my-provider') return new MyProvider(config);
   ```
4. Write a unit test in `packages/embedding/test/`.
5. Nothing else changes. The rest of the system uses the interface.

## During transition (re-export period)

`src/` files are thin re-exports of `packages/`. Existing code that imports
from `src/` continues to work unchanged:

```js
// src/embedding.js (during transition)
export { createTextEmbedder as createEmbedder, cosineSimilarity }
  from '../packages/embedding/src/index.js';
```

Once all `src/` files are re-exports, the directory is removed.
