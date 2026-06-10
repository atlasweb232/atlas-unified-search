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
  const input = texts.map((text) => String(text || '').slice(0, 24000));
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          ...(config.embeddingApiKey ? { Authorization: `Bearer ${config.embeddingApiKey}` } : {}),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.embeddingModel || 'BAAI/bge-base-en-v1.5',
          input,
          dimensions,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(data.detail || data.error?.message || `Embedding API request failed with HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      const vectors = (data.data || []).map((item) => normalize(item.embedding || []));
      if (vectors.length !== input.length) {
        throw new Error(`Embedding provider returned ${vectors.length} vectors, expected ${input.length}`);
      }
      for (const vector of vectors) {
        if (vector.length !== dimensions) {
          throw new Error(`Embedding provider returned ${vector.length} dims, expected ${dimensions}`);
        }
      }
      return vectors;
    } catch (error) {
      lastError = error;
      if (attempt >= 4 || (error.status && ![408, 425, 429, 500, 502, 503, 504].includes(error.status))) throw error;
      await sleep(250 * (2 ** (attempt - 1)));
    }
  }
  throw lastError;
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
