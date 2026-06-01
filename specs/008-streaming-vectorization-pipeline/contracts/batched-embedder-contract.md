# Contract: Batched Embedder (extends 006 TextEmbedder)

## Interface addition

```text
TextEmbedder {
  ...existing (model, version, dim, embed(text))
  embedBatch(texts: string[]): Promise<float32[][]>   # NEW
    # returns one vector per input, same order, each length === dim
    # MUST respect provider max batch size internally (chunk if needed)
}

VisionEmbedder {
  ...existing (model, dim, embed({imageBuffer,mimeType}))
  embedBatch(images: {imageBuffer,mimeType}[]): Promise<float32[][]>  # NEW (005)
}
```

## Rules (MUST)

- `embedBatch` output length === input length, order preserved.
- Each vector length === `dim` (fail fast otherwise — 005/002 dim integrity).
- Internally splits to the provider's max batch (e.g. OpenAI 2048) transparently.
- Hash provider implements `embedBatch` by mapping (proves batch path offline).
- OpenAI provider uses array `input` in one request per provider-batch.

## Rate limiting

- The embed worker (not the embedder) owns a token bucket keyed to provider
  RPM/TPM. The embedder MAY expose `limits { rpm, tpm, maxBatch }` so the worker
  sizes batches and paces calls.

## Verification (credential-free)

- Hash `embedBatch(['a','b','c'])` → 3 vectors, each length `dim`, equal to
  `embed()` of each individually (parity).
- A batch larger than `maxBatch` is internally split and still returns one
  vector per input in order.
