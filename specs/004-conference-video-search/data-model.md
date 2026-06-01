# Data Model (Delta over 001 / 002 / 003)

Additive only. Reuses the existing conference document + `transcript_segment`
child model (already present in `conferenceBridge.js` fixtures); this feature
makes those children come from real recordings and adds timing/playback refs.

## Changed: SearchChunk (transcript segment)

`kind:'transcript_segment'` children become real embedded chunks with timing:

```text
metadata.segment = {
  startTime,            # seconds (or ISO offset) into the recording
  endTime,
  speaker?,             # diarization label, e.g. 'Speaker 1'
  words?: [ { word, start, end } ]   # optional word-level timing
}
metadata.transcription = {
  model, version,       # drives reindex on change
  provider              # 'local' | 'cloud'
  language?
}
metadata.recordingRef   # stable ref for playback (FR-4)
```

## Changed: SearchDocument (conference recording)

Additive fields on the conference document for a recording:

```text
metadata.recording = {
  recordingRef          # stable, opaque; scope-checked on playback
  blobName, container
  mimeType, sizeBytes, durationSeconds
  etag, lastModified    # idempotency checkpoint
  hasSiblingTranscript  # used existing transcript instead of ASR
  transcriptionStatus   # 'pending' | 'completed' | 'failed' | 'skipped'
  skipReason?
}
```

## New: RecordingRef (derived, scope-checked)

```text
recordingRef = stable(conferenceDocumentId + ':' + blobName)
resolves -> { documentId, container, blobName, mimeType, durationSeconds }
```

Used by `/v1/conference/:ref/stream` and `/segment`. Resolution enforces
identity scope (`002`): the parent conference document must be in the caller's
scope.

## New: job type

- `unified_jobs.source` reuses `conference_bridge`; a `transcribe` job kind is
  carried in the job `payload` (`{ kind:'transcribe', recordingRef }`). No new
  table — fits the existing async job model.

## New: audit events

- `transcription_start` / `transcription_complete` / `transcription_error`
- `conference_segment_open` (FR-4), with `actorSubject` from `002`.

## Search result (additive)

Conference line items gain `segment: { start, end, speaker }` and a
`playable: true` flag so the UI can render a play-at-timestamp affordance. No
existing field changes.
