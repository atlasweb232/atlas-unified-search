# Requirements Checklist

## Ingestion
- [ ] Recording blobs discovered (configurable extensions) alongside transcripts.
- [ ] Idempotent by name + etag/lastModified; unchanged recordings not re-transcribed.
- [ ] Sibling text transcript reused when present (skip ASR).
- [ ] Duration/size bounded; oversize → recorded skip, no sync failure.

## Transcription (async, pluggable)
- [ ] Runs only as a background job, never inline in an API request.
- [ ] `TranscriptionProvider` interface; local default (no account) + cloud option.
- [ ] Returns time-coded segments (start/end/text) + diarization where available.
- [ ] ffmpeg dependency documented; per-recording failure isolated + audited.

## Time-coded indexing
- [ ] Segments → embedded `transcript_segment` chunks with start/end/speaker.
- [ ] Transcription model/version stored; reindex on change.
- [ ] Search hit surfaces matched segment timestamp + speaker.
- [ ] Words spoken only in audio are findable via the recording's document.

## Playback (deep-link + seekable)
- [ ] `/stream` full recording supports HTTP Range (seek/scrub).
- [ ] `/segment?start=&end=` returns the correct, seekable time range.
- [ ] Identity-scoped (403 cross-tenant); never a raw/public blob URL.
- [ ] Invalid range → 422/416; segment opens audited.

## Search & workbench
- [ ] Conference results show segment start/end/speaker + play affordance.
- [ ] Selected segments added to 003 workbench with recording+timestamp provenance.
- [ ] Segment usable in summary/report/presentation with cited timestamp.

## Compatibility & CI
- [ ] Additive only; 001 response shapes unchanged.
- [ ] CI runs M1–M5 with NO Slack/Google/Azure/cloud-ASR/LLM credentials
      (local provider or fixture transcripts + local/Azurite blob + ffmpeg).
- [ ] Quickstart demonstrates sync → transcribe → search → play clip offline.

## Out of scope (future)
- [ ] (Deferred) Visual keyframe OCR of shared slides/screens.
- [ ] (Deferred) CLIP-style visual scene embeddings.
- [ ] (Deferred) Live transcription; speaker identification; translation.
