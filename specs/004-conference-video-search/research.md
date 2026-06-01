# Research & Decisions

## 1. Current gap

`ConferenceBridgeConnector.sync` only ingests `.txt/.json/.vtt/.srt` blobs
(`if (!/\.(txt|json|vtt|srt)$/i.test(blob.name)) continue;`). Recordings
(`.mp4/.wav/…`) are never downloaded, transcribed, or indexed. The fixture path
already models `transcript_segment` children with `startTime`, so the data shape
exists — only the production pipeline is missing.

## 2. ASR engine (decision: pluggable, local default)

User chose **pluggable, local default**. Rationale and options:

- **LocalWhisperProvider (default):** whisper.cpp / faster-whisper run in the
  worker. No account, satisfies the credential-free rule. Cost: CPU/GPU + model
  packaging. Quality is good for meeting audio.
- **CloudTranscriptionProvider (optional):** Azure Speech (native diarization,
  good for enterprise) or a Whisper-compatible API. Best quality/scale, needs a
  backend-only key; not required for CI/acceptance.
- One `TranscriptionProvider` interface; `TRANSCRIPTION_PROVIDER=local|cloud`.

Packaging open question: bundle a small model in the worker image (bigger image,
no cold-start download) vs. download-on-first-run vs. a sidecar ASR service. For
CI, prefer the **fixture transcript path** so we don't ship a model into CI.

## 3. Why transcription must be async

ASR on a 1-hour recording takes minutes; it cannot run inside an API request.
Decision: reuse the existing `001` Service Bus worker + `JobRunner`. The
connector emits recording metadata immediately and enqueues a `transcribe` job;
segments + embeddings land when the job completes. This matches the existing
"sync is a background job" model and keeps the API responsive.

## 4. ffmpeg dependency

Audio extraction from video and time-accurate clipping both need `ffmpeg`. It is
a system binary (no account) and is available in standard CI images and the
worker container. Documented as a runtime dependency.

## 5. Seekable playback & clip delivery (decision: deep-link + seekable clip)

Azure Blob supports HTTP **Range** requests, so full-recording scrubbing
(`/stream`) can proxy ranges or hand out a short-lived backend-signed,
range-capable URL — never a raw/public URL.

For `/segment?start=&end=` two options:

- **ffmpeg clip-on-demand (recommended):** slice exactly `[start,end]`,
  time-accurate, with a short-TTL clip cache for repeats. More CPU per request.
- **Pre-segmented at ingest (HLS / fixed chunks):** faster to serve, more
  storage, coarser boundaries.

Decision: clip-on-demand for accuracy in MVP; revisit pre-segmentation/HLS if
serve latency matters at scale.

## 6. Time → byte/seek precision

Store segment `start/end` (and optional word-level timings) in chunk metadata so
the UI can seek precisely and highlight. A side table for word timings is an
option if metadata grows large (open question).

## 7. Diarization

Use the ASR provider's diarization where available (Azure Speech and some
Whisper pipelines provide it); otherwise segments carry no speaker and the UI
degrades to timestamp-only. A separate diarization step is a future option.
Speaker *identification* (mapping "Speaker 1" → a real person) is out of scope.

## 8. Idempotency & retention

- Re-transcription is avoided via a `name + etag/lastModified` checkpoint
  (existing `unified_checkpoints`). A transcription model/version change drives a
  reindex (consistent with `001`/`002`).
- Open: keep transcripts longer than large media files? Transcripts are cheap and
  high-value; recordings are large. May warrant separate retention cutoffs.

## 9. Credential-free verification

- Downstream (segment → embed → search → timestamp → clip) tested with fixture
  transcripts + a short synthetic sample recording on local files / Azurite.
- Local ASR runs offline; CI can either run it on a few-second clip or use the
  fixture transcript path to stay light. Cloud ASR only runs when a key is set.

## 10. Scope discipline (audio only)

User chose **audio transcript only**. Visual layers (keyframe OCR of shared
slides, CLIP-style scene similarity) are deliberately deferred — they need vision
models/OCR and materially expand infra. Captured as a future feature so this one
stays shippable.
