# Feature Spec: Conference Video Search (Audio Transcript)

## Summary

Make conference bridge **recordings** (video/audio) searchable by what was said,
and let a search hit jump to and play the exact moment. Today the conference
connector ingests only text transcript blobs (`.txt/.json/.vtt/.srt`) and
explicitly skips actual recordings (`if (!/\.(txt|json|vtt|srt)$/i...) continue`),
so `.mp4`/`.m4a`/`.wav` recordings are never transcribed or indexed.

This feature adds an **audio transcription pipeline** to the conference
connector: recordings are transcribed (pluggable ASR, local model by default),
diarized (who spoke when), split into **time-coded transcript segments**, and
embedded as child chunks. A search hit returns the matched segment with its
timestamp, and a playback endpoint streams that **seekable clip** back from the
source recording.

Scope is **audio transcript only** (decision). Visual search — keyframe OCR of
shared slides and CLIP-style scene embeddings — is explicitly deferred to a
future feature.

## Decisions (locked)

- **ASR engine:** pluggable `TranscriptionProvider`. Default = **local model**
  (e.g. whisper.cpp / faster-whisper) for offline, no-account operation;
  optional = **cloud** (Azure Speech / Whisper-compatible API) behind the same
  interface, selected by config.
- **Modalities:** **audio transcript only** — speech→text + diarization +
  timestamps. No visual OCR / scene embeddings in this feature.
- **Playback:** **deep-link + seekable clip** — a hit carries its start/end time;
  a playback endpoint streams that time range from the source recording, seekable
  (jump to 14:32 and play). Builds on `003` attachment reconstruction.

## Dependencies

- `002` foundation: scoped pgvector retrieval + identity-bound access.
- `003` reconstruction: backend-controlled fetch of source bytes / short-lived
  signed URLs (the segment playback endpoint extends this with time ranges).
- Existing async path: the `001` Service Bus worker / `JobRunner` — transcription
  is long-running and MUST run as a background job, not inline.

## Problem Statement

- Recordings are not ingested: the connector's blob loop skips any non-text
  extension, so audio/video is invisible to search.
- The data model already anticipates `kind:'transcript_segment'` children with
  `startTime` (see `conferenceBridge.js` fixture mapping), but nothing produces
  them from a real recording.
- There is no way to transcribe, no time-coded indexing of recordings, and no
  way to play the matched moment.

## Functional Requirements

### FR-1: Recording ingestion

- The conference connector MUST discover recording blobs (configurable
  extensions, default `mp4,m4a,mp3,wav,webm,mov`) in the configured containers,
  in addition to the existing text transcript blobs.
- Ingestion MUST be idempotent by blob identity (name + `etag`/`lastModified`
  checkpoint) so a recording is not re-transcribed on every sync.
- If a sibling text transcript already exists for a recording (same base name,
  `.vtt/.srt/.json`), the connector MAY use it directly and skip ASR.
- Recordings MUST be bounded by configurable duration/size limits; oversize
  recordings record a skip reason and do not fail the sync.

### FR-2: Transcription pipeline (async, pluggable)

- Transcription MUST run as a background job (worker/queue), never inline in an
  API request, because it is long-running.
- A `TranscriptionProvider` interface MUST be defined with:
  - **Local provider (default):** runs a local ASR model; requires no account.
  - **Cloud provider (optional):** Azure Speech / Whisper-compatible; backend-only
    credentials.
- The provider MUST return time-coded segments:
  `{ start, end, text, speaker? }[]` plus optional word-level timings.
- Diarization (speaker labels per segment) MUST be supported where the provider
  offers it; absence MUST degrade gracefully (segments without speaker).
- Audio extraction/normalization from video (e.g. via `ffmpeg`) is part of the
  pipeline; the system dependency MUST be documented. Failures are isolated per
  recording with a recorded error.

### FR-3: Time-coded indexing

- Each transcript segment MUST become a child chunk
  (`kind:'transcript_segment'`) on the conference document, carrying
  `startTime`/`endTime`, `speaker`, and the segment text — embedded and
  searchable via the `002` retrieval path.
- A search hit MUST surface the matched segment's timestamp and speaker so the
  UI can show "at 14:32, <speaker>: …" and offer play.
- Re-transcription (model/version change) MUST be reindex-driven, consistent with
  the `001`/`002` "reindex when embedding/model changes" rule; segment chunks
  carry the transcription model/version.

### FR-4: Deep-link + seekable clip playback

- Provide `GET /v1/conference/:recordingRef/segment?start=&end=` that streams the
  requested **time range** of the source recording, seekable (HTTP range / a
  clipped media response), with the correct content type.
- Provide `GET /v1/conference/:recordingRef/stream` for the full seekable
  recording (range requests) for users who want to scrub.
- Playback MUST be identity-scoped (`002`): only if the parent conference
  document is in the caller's scope; otherwise `403`.
- MUST NOT expose a raw Azure Blob URL or any public URL; bytes are proxied or a
  short-lived backend-signed, range-capable URL is issued.
- All playback/segment opens MUST be audited (`conference_segment_open`).

### FR-5: Search & workbench integration

- Conference video segments participate in unified search like any other source;
  results carry source icon, one-liner (segment text), speaker, timestamp, and a
  play affordance, and are expandable to surrounding segments.
- Selected segments can be added to the `003` ephemeral workbench and used by
  assistant actions (summarize / report / presentation) with provenance that
  includes the recording + timestamp range.

## Security & Tenancy

- Recordings, transcripts, and clips are identity-scoped per `002`; cross-tenant
  playback/segment access is denied.
- No raw/public blob URLs are returned (FR-4).
- Transcripts may contain sensitive speech; they are subject to the same
  redaction and retention rules as other indexed content, and segment opens are
  audited.
- Cloud ASR sends audio only to the configured backend provider; provider
  credentials remain backend-only.

## Non-Goals (this feature)

- Visual search: keyframe OCR of shared slides/screens, and CLIP-style scene
  embeddings (deferred to a future feature).
- Real-time/live transcription of in-progress meetings.
- Speaker *identification* against a known directory (diarization labels speakers
  as Speaker 1/2/…; mapping to real identities is future).
- Translation/subtitling beyond what the ASR provider returns.

## No-Live-Credentials Verification Strategy

- The downstream pipeline (segment → embed → search → timestamp → clip playback)
  is fully testable offline with **fixtures**: pre-made transcript segments with
  timestamps + a small local sample recording (synthetic) committed under the
  repo / served by a local blob mock (Azurite or local files).
- ASR itself: the **local provider** runs offline with no account; CI MAY run it
  on a few-second sample, or use the fixture transcript path to avoid bundling a
  model in CI. The **cloud provider** is exercised only when a key is present and
  is not required for acceptance.
- `ffmpeg` is a build/runtime system dependency (no account) and is available in
  CI images.

## Acceptance Criteria

1. Syncing a container with a recording blob (no sibling transcript) produces
   time-coded `transcript_segment` child chunks via the local ASR provider, with
   per-segment start/end and speaker where available — with no external account.
2. A search for words spoken only in the recording returns the conference
   document and identifies the matched segment's timestamp and speaker.
3. `GET /v1/conference/:ref/segment?start=&end=` streams exactly that time range,
   is seekable, returns the correct content type, never a raw/public blob URL,
   and is rejected `403` for an out-of-scope caller; the open is audited.
4. Re-running sync does not re-transcribe an unchanged recording (etag/lastModified
   checkpoint); a model/version change triggers reindex.
5. Transcription runs as a background job; the API does not block on it, and a
   failed/oversize recording is isolated without failing the sync.
6. A matched segment can be added to the workbench and included (with recording +
   timestamp provenance) in a summary/report/presentation from `003`.
7. The pipeline test suite runs in CI with **no Slack/Google/Azure/cloud-ASR/LLM
   credentials** (local provider or fixture transcripts + local/Azurite blob).

## Open Questions

- Local ASR packaging: bundle a small model in the worker image vs. download on
  first run vs. a sidecar transcription service? (image size vs. cold start).
- Clip delivery: server-side `ffmpeg` clip-on-demand (time-accurate, more CPU)
  vs. pre-segmented HLS/byte-range at ingest (more storage, faster serve)?
- Where to store word-level timings (chunk metadata vs. a side table) for precise
  highlight/seek?
- Retention of transcripts vs. recordings — same cutoffs, or transcripts kept
  longer than large media?
- Diarization quality: rely on the ASR provider's diarization, or add a separate
  diarization step?
