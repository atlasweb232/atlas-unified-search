# Implementation Plan

## Where this sits

```text
002 foundation (pgvector + identity)   003 reconstruction + workbench + artifacts
        └──────────────┬──────────────────────────┬───────────────┘
                       ▼                          ▼
004 conference video search (audio transcript only):
   recording blob ─► async transcription job ─► time-coded segments ─► embed
                                                         │
   search hit (segment + timestamp + speaker) ──► play seekable clip from source
```

## Ingestion (extend ConferenceBridgeConnector)

- Add recording extensions (`CONFERENCE_RECORDING_EXTENSIONS`, default
  `mp4,m4a,mp3,wav,webm,mov`) alongside the existing text-transcript loop.
- For each recording blob: checkpoint by `name + etag/lastModified`; skip if
  unchanged. If a sibling transcript (`.vtt/.srt/.json`, same base) exists, use it
  and skip ASR.
- A recording the connector decides to transcribe is **not transcribed inline**.
  The connector emits a lightweight conference document (recording metadata) and
  enqueues a `transcribe` job (reuse `JobRunner`/Service Bus) carrying the blob
  ref + scope. Bound by `CONFERENCE_MAX_DURATION`/size.

## Transcription pipeline (worker)

- New `src/transcription/provider.js` with a `TranscriptionProvider` interface
  and two implementations:
  - `LocalWhisperProvider` (default): extract audio with `ffmpeg`, run a local
    ASR model, return `{ segments:[{start,end,text,speaker?}], words? }`. No
    account.
  - `CloudTranscriptionProvider` (optional): Azure Speech / Whisper-compatible
    HTTP; backend-only key. Same return shape.
- New worker job type `transcribe` (handled in `src/worker.js` /`JobRunner`):
  download blob (via `003` source-fetch), provider.transcribe, map segments to
  `kind:'transcript_segment'` children with `startTime`/`endTime`/`speaker`,
  upsert the conference document, embed segment chunks (`002` path).
- `ffmpeg` is a documented system dependency (audio extraction + clipping).
- Failure isolation per recording; record `transcription_error` + skip reason.

## Time-coded indexing

- Segment child chunks carry `startTime`, `endTime`, `speaker`,
  `transcriptionModel`, `transcriptionVersion`. `createChunks` already chunks
  `children[].text`, so segments become embedded chunks with these fields in
  metadata.
- Search result line items expose `segment.start/end/speaker` so the UI can show
  "at mm:ss, <speaker>: …" and a play button; expanding shows neighbouring
  segments.

## Playback (extend 003 reconstruction with time ranges)

- `recordingRef` = stable ref for the recording blob (like `003` attachmentRef).
- `GET /v1/conference/:ref/stream`: full recording, **HTTP Range** supported
  (seekable scrub) — proxy bytes or `302` to a short-lived backend-signed,
  range-capable URL. Never a raw/public blob URL.
- `GET /v1/conference/:ref/segment?start=&end=`: serve just that time range.
  Decision (research): server-side `ffmpeg` clip-on-demand for time accuracy
  (with a short-TTL clip cache), or pre-segmented at ingest. Identity-scoped;
  audited `conference_segment_open`.

## Search / workbench integration

- No new search surface — conference segments flow through the `002` retrieval +
  `001` search-run path. Result shape gains additive `segment` info.
- Selected segments add to the `003` workbench; assistant actions cite
  `recordingRef` + `start/end` in provenance.

## Schema / migration

- `migrations/004_*.sql` (additive): segment timing fields/index if querying by
  time; transcription model/version on chunks; recording checkpoint already fits
  `unified_checkpoints`.

## Verification order (credential-free)

1. Connector recording discovery + checkpoint + enqueue (no ASR run; fixtures).
2. `TranscriptionProvider` interface + fixture/local provider → segments.
3. Segment indexing + search returns timestamp/speaker.
4. Full-recording seekable `/stream` (range requests) against local/Azurite blob.
5. `/segment` clip-on-demand (ffmpeg) + scope + audit.
6. Workbench + report/presentation provenance with timestamps.
7. CI: local provider or fixture transcripts + local/Azurite blob, no accounts.
