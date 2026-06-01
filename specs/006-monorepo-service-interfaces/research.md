# Research & Decisions

## 1. Why the monolith hurts now

- `src/app.js` (1114 lines): route handlers directly call `store.listChunks()`,
  compute production readiness, verify webhook signatures, and write audit
  events. Adding a new route means adding to an already unreadable file.
- `src/store.js`: `SearchEngine` and `JsonSearchStore` share a file. `SearchEngine`
  currently imports `cosineSimilarity` from `embedding.js` directly — it can't
  be tested without the embedder. Splitting them makes unit testing trivial.
- `src/stores/postgresStore.js` extends `JsonSearchStore` and inherits the
  full-state-blob pattern. A clean `VectorStore` interface forces the Postgres
  adapter to be a real database client, not a serializer.
- `src/embedding.js`: `embed(text)` only. A vision embedder that takes a Buffer
  cannot fit this signature without breaking every caller.

## 2. Packaging: npm workspaces (decision)

npm workspaces (built into npm 7+, already available) over alternatives:
- **yarn workspaces / pnpm workspaces**: equivalent feature set; npm is already
  the package manager in use (`package-lock.json`).
- **separate repos**: maximum isolation but requires a private registry, inter-repo
  versioning, and a service mesh for inter-service calls. Premature for this stage.
- **Turborepo/Nx**: build caching on top of workspaces; useful later, not needed
  for the initial extraction.

Decision: **npm workspaces**, packages under `packages/`. No build caching tool
yet; revisit when build times matter.

## 3. Package naming

`@atlas/embedding`, `@atlas/store`, etc. The scope `@atlas` is private (not
published to npm). `package.json` `"private": true` on each package. No
registry needed.

## 4. Config package: root vs. own package

Options:
- **Root `config.js` imported by all packages**: simpler, packages declare
  `env` vars they need in their own README, root assembles them.
- **`@atlas/config` package**: single source of truth, explicit; adds one
  dependency to every package.

Decision: **keep `src/config.js` at root** for now; packages accept their
config slice as a constructor argument (already the pattern). If the config
grows unwieldy, extract to `@atlas/config` as a follow-on.

## 5. `DocumentStore` vs `VectorStore` split rationale

Today `PostgresSearchStore` mixes:
- Operational records (documents, jobs, search runs, assistant actions, audit)
- Vector storage (embedding column, ANN index)

These have different swap lifecycles:
- You might swap the vector backend (pgvector → Qdrant) while keeping Postgres
  for operational records.
- You might keep pgvector for vectors while swapping operational records to a
  different Postgres schema or a different DB.

Splitting them at the interface level costs nothing today and makes both swaps
independent. The concrete `PostgresAdapter` can implement both interfaces while
sharing a connection pool — just separate code paths.

## 6. Incremental migration strategy (no big-bang)

The risk of a full restructure is that tests break mid-way and it's unclear
which change caused the failure. The re-export pattern eliminates this:

```js
// src/embedding.js during transition
export { createTextEmbedder as createEmbedder, cosineSimilarity, hashEmbedding }
  from '../packages/embedding/src/index.js';
```

All existing imports of `src/embedding.js` continue to work. Tests keep
passing. The monolith shrinks file by file. When all files are re-exports, the
`src/` directory is removed.

## 7. Swap urgency recap

| Interface | Urgency | Blocking |
|---|---|---|
| `TextEmbedder` / `VisionEmbedder` | 🔴 Immediate | `005` vision embedder |
| `VectorStore` | 🔴 Immediate | `002 M3` ANN queries; `005` two spaces |
| `DocumentStore` | 🟡 Soon | Clean separation; unblocks `003` workbench |
| `ArtifactProvider` | 🟡 Soon | `003 M5` real pptx/pdf |
| `Queue` / `Receiver` | 🟡 Soon | Local dev without Service Bus |
| `ChatProvider` | 🟢 Already close | Interface exists; just needs to be explicit |
| `IdentityResolver` | 🟡 Soon | `002 M5` JWT/api-key |
| HTTP routes | 🟢 Later | Nothing blocked; just quality |

## 8. BullMQ stub rationale

BullMQ (Redis-backed) as a local dev queue eliminates the need for a Service
Bus connection string during development. It requires Redis — but Redis is also
the production choice for the `003 M4` workbench store, so it's infrastructure
that's likely coming anyway. The stub in `006` means the interface is there;
the real impl is a 30-line adapter when needed.

## 9. What stubs mean in this spec

A "stub" is a class that implements the interface and either:
- throws `NotImplementedError` with a clear message, or
- returns empty/mock data.

It exists so that: (a) the interface is proven by having at least one
implementation, (b) future implementers have a template, (c) tests can import
the stub without needing real infrastructure.
