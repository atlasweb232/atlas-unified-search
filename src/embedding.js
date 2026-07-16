export async function createEmbedder(config) {
  const dimensions = Number(config.embeddingDim) || 768;
  if (config.embeddingProvider === 'bge_api') {
    if (!config.embeddingApiUrl) throw new Error('EMBEDDING_API_URL is required for bge_api');
    return {
      model: config.embeddingModel || 'BAAI/bge-base-en-v1.5',
      version: `bge-api:${config.embeddingModel || 'BAAI/bge-base-en-v1.5'}:${dimensions}`,
      dimensions,
      embed: (text) => apiEmbedding(config, text, dimensions),
      embedMany: (texts) => apiEmbeddings(config, texts, dimensions),
    };
  }
  if (config.embeddingProvider === 'openai' && config.openaiApiKey) {
    return {
      model: config.embeddingModel,
      // version encodes the dimension so a dim change is detected as stale (reindex).
      version: `openai:${config.embeddingModel}:${dimensions}`,
      dimensions,
      embed: (text) => openaiEmbedding(config, text, dimensions),
    };
  }
  return {
    model: 'hash-embedding',
    version: `hash:v1:${dimensions}`,
    dimensions,
    embed: async (text) => hashEmbedding(text, dimensions),
  };
}

async function apiEmbedding(config, text, dimensions) {
  const vectors = await apiEmbeddings(config, [text], dimensions);
  return vectors[0];
}

async function apiEmbeddings(config, texts, dimensions) {
  const endpoint = new URL('/v1/embeddings', ensureTrailingSlash(config.embeddingApiUrl));
  const sanitized = texts.map((text) => String(text || '').slice(0, 24000));
  // Skip the network call entirely for empty/blank inputs — saves a round-trip
  // and avoids bugs in some tokenizers when fed zero-length strings.
  const nonEmpty = sanitized.filter((value) => value.trim().length > 0);
  if (!nonEmpty.length) return sanitized.map(() => new Array(dimensions).fill(0));
  const body = JSON.stringify({
    model: config.embeddingModel || 'BAAI/bge-base-en-v1.5',
    input: nonEmpty,
    dimensions,
  });
  const headers = {
    ...(config.embeddingApiKey ? { Authorization: `Bearer ${config.embeddingApiKey}` } : {}),
    'Content-Type': 'application/json',
  };
  // First attempt: batch. If batch fails (some BGE versions crash on certain
  // inputs), fall back to per-text single requests and skip un-embeddable ones.
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(endpoint, { method: 'POST', headers, body });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(data.detail || data.error?.message || `Embedding API request failed with HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      const vectors = (data.data || []).map((item) => normalize(item.embedding || []));
      if (vectors.length !== nonEmpty.length) {
        throw new Error(`Embedding provider returned ${vectors.length} vectors, expected ${nonEmpty.length}`);
      }
      // Re-map to original positions: empty inputs get zero vectors.
      let cursor = 0;
      return sanitized.map((value) => {
        if (!value.trim().length) return new Array(dimensions).fill(0);
        const v = vectors[cursor++];
        if (v.length !== dimensions) throw new Error(`Embedding provider returned ${v.length} dims, expected ${dimensions}`);
        return v;
      });
    } catch (error) {
      lastError = error;
      if (attempt >= 2) break;
      await sleep(250);
    }
  }
  // Batch path failed twice — fall back to per-text single requests.
  const fallback = [];
  for (const value of sanitized) {
    if (!value.trim().length) { fallback.push(new Array(dimensions).fill(0)); continue; }
    try {
      fallback.push(await apiEmbedding(config, value, dimensions));
    } catch (error) {
      // Last-resort: log and emit a zero vector so the chunk is at least
      // queryable by lexical match (no vector contribution).
      console.warn(`[embedding] skipped un-embeddable text (${error.message}); preview: ${JSON.stringify(value.slice(0, 80))}`);
      fallback.push(new Array(dimensions).fill(0));
    }
  }
  return fallback;
}

function ensureTrailingSlash(value) {
  return value.endsWith('/') ? value : `${value}/`;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// Fail-fast guard: the embedder MUST produce vectors at exactly the configured
// width, or every Postgres write would silently store NULL (the original bug).
export function assertEmbedderDimension(embedder, expectedDim) {
  const expected = Number(expectedDim);
  if (!Number.isFinite(expected) || expected <= 0) {
    throw new Error(`Invalid EMBEDDING_DIM: ${expectedDim}`);
  }
  if (!embedder || !Number.isFinite(embedder.dimensions)) {
    throw new Error('Embedder must declare a numeric `dimensions`');
  }
  if (embedder.dimensions !== expected) {
    throw new Error(
      `Embedding dimension mismatch: embedder=${embedder.dimensions} but EMBEDDING_DIM=${expected}. `
      + 'Set EMBEDDING_DIM to the embedder width and migrate the vector column to match.',
    );
  }
}

export function hashEmbedding(text, dimensions = 384) {
  const vector = new Array(dimensions).fill(0);
  const tokens = String(text || '').toLowerCase().match(/[a-z0-9_@#.-]+/g) || [];
  for (const token of tokens) {
    vector[Math.abs(hash(token)) % dimensions] += 1;
  }
  return normalize(vector);
}

export function cosineSimilarity(left, right) {
  if (!left?.length || !right?.length) return 0;
  let score = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) score += left[index] * right[index];
  return score;
}

async function openaiEmbedding(config, text, dimensions) {
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openaiApiKey}`,
      'Content-Type': 'application/json',
    },
    // text-embedding-3-* honours `dimensions`, so OpenAI output matches the
    // configured column width (e.g. 768) instead of its native 1536.
    body: JSON.stringify({ model: config.embeddingModel, input: String(text || '').slice(0, 24000), dimensions }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || 'Embedding request failed');
  const vector = normalize(data.data?.[0]?.embedding || []);
  if (vector.length !== dimensions) {
    throw new Error(`Embedding provider returned ${vector.length} dims, expected ${dimensions}`);
  }
  return vector;
}

function normalize(vector) {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm ? vector.map((value) => value / norm) : vector;
}

function hash(value) {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result;
}
