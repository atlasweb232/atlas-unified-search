export async function createEmbedder(config) {
  if (config.embeddingProvider === 'openai' && config.openaiApiKey) {
    return {
      model: config.embeddingModel,
      version: `openai:${config.embeddingModel}`,
      embed: (text) => openaiEmbedding(config, text),
    };
  }
  return {
    model: 'hash-embedding',
    version: 'hash:v1',
    embed: async (text) => hashEmbedding(text),
  };
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

async function openaiEmbedding(config, text) {
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openaiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: config.embeddingModel, input: String(text || '').slice(0, 24000) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || 'Embedding request failed');
  return normalize(data.data?.[0]?.embedding || []);
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
