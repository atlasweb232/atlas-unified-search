# Contract: Transcription Provider (ASR)

Pluggable audio→text behind one interface; local default, cloud optional.

## Interface

```text
TranscriptionProvider {
  name                     # 'local' | 'cloud'
  configured() -> boolean
  transcribe({ audioPath | stream, mimeType, durationSeconds, language? })
     -> TranscriptionResult
}

TranscriptionResult {
  segments: [ {
    start,      # seconds from recording start
    end,
    text,
    speaker?    # diarization label, e.g. 'Speaker 1'
  } ]
  words?: [ { word, start, end, speaker? } ]   # optional word-level timing
  model, version, provider, language?
}
```

## Implementations

### LocalWhisperProvider (default)
- Extracts audio via `ffmpeg`, runs a local ASR model (whisper.cpp /
  faster-whisper). **No external account.** Selected by
  `TRANSCRIPTION_PROVIDER=local` (default).
- Diarization where the local pipeline supports it; otherwise segments omit
  `speaker`.

### CloudTranscriptionProvider (optional)
- Azure Speech or Whisper-compatible HTTP API; backend-only credentials.
- Selected by `TRANSCRIPTION_PROVIDER=cloud`. Same `TranscriptionResult` shape.

## Execution rules

- Runs only inside the `transcribe` background job (worker), never in an API
  request.
- Bounded by `CONFERENCE_MAX_DURATION` / size; oversize → skip with reason.
- Per-recording failure isolation; emits `transcription_error` audit and does not
  fail the surrounding sync.
- Output segments map to `kind:'transcript_segment'` child chunks with
  start/end/speaker + transcription model/version (drives reindex on change).

## Verification (credential-free)

- Local provider transcribes a few-second synthetic clip offline; or the fixture
  transcript path supplies `segments` directly so CI needs no model.
- Asserts: segments have monotonic `start/end`, text present, model/version set;
  cloud provider exercised only when a key is configured.
