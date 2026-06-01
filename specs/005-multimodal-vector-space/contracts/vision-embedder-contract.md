# Contract: Vision Embedder

## Interface

```text
VisionEmbedder {
  name
  dim: number                 # must equal VISION_EMBEDDING_DIM
  configured() → boolean
  embed({ imagePath | imageBuffer, mimeType }) → float32[dim]
}
```

## Implementations

### LocalClipProvider (default, `VISION_EMBEDDING_PROVIDER=local`)
- Runs CLIP (e.g. ViT-B/32) locally — no account, offline CI.
- Bridge: JS ONNX runtime (`onnxruntime-node`) loading a quantised CLIP model,
  or a small Python sidecar (`clip-server`).
- Input: JPEG/PNG/WebP Buffer or file path.
- Output: float32[512], L2-normalised.

### ApiVisionEmbedder (optional, `VISION_EMBEDDING_PROVIDER=api`)
- Sends image bytes to a configured vision embedding endpoint.
- Backend-only credentials. Same output shape.

## Rules (MUST)

- `embed()` output length MUST equal `this.dim`; if not, throw (never silent
  wrong-dim vector).
- Unsupported mime types (video, audio, etc.) MUST throw with a clear reason
  rather than returning a zero vector.
- Image resizing/normalisation to model input size MUST happen inside the
  provider, not in calling code.

## Modality routing

The chunk writer calls `VisionEmbedder.embed()` only when
`chunk.metadata.modality === 'image'`. Audio and text chunks never reach the
vision embedder.

## Verification (credential-free)

- Local CLIP embeds a fixture PNG and returns float32[512].
- Two visually similar fixture images score higher cosine similarity than two
  dissimilar ones.
- Wrong-dim output → startup error (dim assertion).
- Passing a video buffer → clear error, not a zero vector.
