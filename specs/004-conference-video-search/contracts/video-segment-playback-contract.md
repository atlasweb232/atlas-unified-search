# Contract: Video Segment Playback (Deep-link + Seekable Clip)

Extends `003` reconstruction with time-range, seekable media. Bytes are proxied
or a short-lived backend-signed, range-capable URL is issued — never a raw or
public blob URL.

## Endpoints

### `GET /v1/conference/:recordingRef/stream`
- Streams the full recording, **HTTP Range** supported (`Range: bytes=...` →
  `206 Partial Content` + `Accept-Ranges: bytes`) so clients can scrub/seek.
- Or `302` to a short-lived backend-signed, range-capable URL.
- Identity-scoped (`002`): parent conference document must be in caller scope.

### `GET /v1/conference/:recordingRef/segment?start=&end=`
- `start`/`end` in seconds. Returns just that time range as a playable, seekable
  media response with the correct `Content-Type`.
- Delivery: server-side `ffmpeg` clip-on-demand (time-accurate) with an optional
  short-TTL clip cache, or a pre-segmented source.
- Identity-scoped; audited `conference_segment_open`.

### `GET /v1/conference/:recordingRef` (metadata)
- `{ recordingRef, mimeType, sizeBytes, durationSeconds, container,
  transcriptionStatus, hasSiblingTranscript }`. Same scope rules.

## recordingRef

- Stable, opaque, derived from conference document + blob name; resolution always
  re-checks identity scope regardless of guessability.

## Responses

```text
200  full media (no range)        206  partial content (range / clip)
302  short-lived signed range URL
401  unauthenticated
403  authenticated but recording out of scope
404  ref not found in scope
416  range not satisfiable
422  invalid start/end (end<=start, out of bounds)
502  source fetch / clip failed
```

## Rules

- Never returns a raw Azure Blob URL or any public URL.
- `start`/`end` clamped to `[0, durationSeconds]`; `end<=start` → `422`.
- Every open audited with `actorSubject` (`002`).

## Verification (credential-free)

- Against local files / Azurite: a `Range` request returns `206` with the right
  slice; `/segment` returns the requested time range; cross-tenant → `403`;
  response body/headers contain no raw/public URL; open is audited.
