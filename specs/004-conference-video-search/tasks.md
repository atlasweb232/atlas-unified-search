# Tasks

Audio-transcript-only. Depends on `002` (pgvector+identity) and `003`
(reconstruction + workbench). Verifiable with **no Slack/Google/Azure/cloud-ASR/
LLM credentials** — local ASR provider or fixture transcripts, local/Azurite
blob, `ffmpeg`, deterministic embedder.

## Speckit
- [ ] Define conference video search (audio) feature (this spec).
- [ ] Define transcription provider contract.
- [ ] Define video segment playback contract.

## M1: Recording ingestion
- [ ] Extend ConferenceBridgeConnector to discover recording blobs
      (`CONFERENCE_RECORDING_EXTENSIONS`, default mp4/m4a/mp3/wav/webm/mov).
- [ ] Idempotent checkpoint by blob name + etag/lastModified.
- [ ] Use a sibling text transcript (same base) if present; skip ASR.
- [ ] Duration/size bounds; oversize → recorded skip reason, no sync failure.
- [ ] Emit recording metadata doc + enqueue `transcribe` job (no inline ASR).
- [ ] Tests (fixtures): recording discovered, checkpointed, job enqueued.

## M2: Transcription pipeline (async, pluggable)
- [ ] `TranscriptionProvider` interface (`transcribe -> { segments, words? }`).
- [ ] `LocalWhisperProvider` (default, offline, ffmpeg audio extraction).
- [ ] `CloudTranscriptionProvider` (optional, Azure Speech / Whisper API).
- [ ] `transcribe` worker job: fetch blob → transcribe → segments → index.
- [ ] Diarization (speaker per segment) where available; graceful absence.
- [ ] Per-recording failure isolation + `transcription_error` audit.
- [ ] Document `ffmpeg` system dependency.
- [ ] Tests: fixture/local provider yields time-coded segments, no account.

## M3: Time-coded indexing
- [ ] Segments → `kind:'transcript_segment'` children with start/end/speaker.
- [ ] Carry transcription model/version; reindex on change.
- [ ] Search hit surfaces matched segment timestamp + speaker.
- [ ] Tests: words spoken only in audio are searchable; timestamp returned.

## M4: Deep-link + seekable clip playback
- [ ] `recordingRef` derivation (per 003 reconstruction).
- [ ] `GET /v1/conference/:ref/stream` full recording, HTTP Range / signed URL.
- [ ] `GET /v1/conference/:ref/segment?start=&end=` clip-on-demand (ffmpeg) or
      pre-segmented; correct content type; seekable.
- [ ] Identity-scoped (403 cross-tenant); never a raw/public blob URL.
- [ ] `conference_segment_open` audited; optional short-TTL clip cache.
- [ ] Tests: range request seeks; segment range correct; cross-tenant → 403.

## M5: Search & workbench integration
- [ ] Result line items expose segment start/end/speaker + play affordance.
- [ ] Expand shows neighbouring segments.
- [ ] Add segment to 003 workbench; provenance carries recordingRef + start/end.
- [ ] Tests: segment in report/presentation cites recording + timestamp.

## M6: Integration & CI
- [ ] `migrations/004_*.sql` additive (segment timing + transcription model/version).
- [ ] Local/Azurite blob fixture with a short synthetic sample recording.
- [ ] Quickstart: sync recording → transcribe → search → play clip offline.
- [ ] CI runs M1–M5 with NO Slack/Google/Azure/cloud-ASR/LLM credentials.
- [ ] Confirm 001 response shapes unchanged (additive segment info only).

## Out of scope (future feature)
- Visual keyframe OCR (shared slides/screens) and CLIP-style scene embeddings.
- Live/real-time meeting transcription.
- Speaker identification against a real directory.
- Translation/subtitling beyond ASR output.
