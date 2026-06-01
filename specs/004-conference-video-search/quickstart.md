# Quickstart: Credential-Free Conference Video Search

Demonstrates: ingest a recording → transcribe (local) → search by what was said
→ jump to and play the matched clip — with **no Slack/Google/Azure/cloud-ASR/LLM
account**.

Prereqs: `002` (pgvector + identity) and `003` (reconstruction) from their
quickstarts, plus `ffmpeg` installed.

## 1. Local blob + config (no cloud)

```bash
# Local Azure Blob emulator (no account):
docker run --rm -d --name uss-azurite -p 10000:10000 \
  mcr.microsoft.com/azure-storage/azurite azurite-blob --blobHost 0.0.0.0
export AZURE_STORAGE_CONNECTION_STRING="<azurite-dev-connection-string>"
export CONFERENCE_BLOB_CONTAINERS=recordings
export CONFERENCE_RECORDING_EXTENSIONS=mp4,m4a,mp3,wav,webm,mov

# Local ASR, no key:
export TRANSCRIPTION_PROVIDER=local
export CONFERENCE_MAX_DURATION=3600
```

No `*_API_KEY` / cloud ASR variables required. (CI may instead use the fixture
transcript path to avoid running a model.)

## 2. Seed a recording (synthetic)

```bash
# Upload a short synthetic sample recording to the local container,
# or use the fixture transcript path:
npm run seed:fixtures   # includes a conference recording fixture
```

## 3. Sync → background transcription

```bash
# Connector discovers the recording and enqueues a transcribe job (async):
curl -s localhost:4420/v1/sync/conference_bridge -H "$AUTH" \
  -d '{"tenantId":"t","userId":"u"}'

# Watch the job; segments + embeddings land when transcription completes:
curl -s "localhost:4420/v1/jobs?tenantId=t&userId=u" -H "$AUTH"
```

## 4. Search by what was said

```bash
curl -s localhost:4420/v1/search -H "$AUTH" \
  -d '{"tenantId":"t","userId":"u","query":"decision about the Q3 budget"}'
# A conference hit returns the matched segment: { start, end, speaker } + playable:true
```

## 5. Jump to and play the moment

```bash
# Seekable clip of just the matched range (streamed from source, not a public URL):
curl -s -OJ "localhost:4420/v1/conference/<recordingRef>/segment?start=872&end=905" -H "$AUTH"

# Or scrub the whole recording (HTTP Range supported):
curl -s -r 0-1048575 "localhost:4420/v1/conference/<recordingRef>/stream" -H "$AUTH" -o head.bin
```

## 6. Use it downstream (003)

Add the segment to the workbench and include it in a summary/report/presentation;
provenance cites the recording + timestamp range.

## 7. What needs accounts (out of scope / optional)

- Cloud ASR (`TRANSCRIPTION_PROVIDER=cloud`, Azure Speech / Whisper API) — optional
  quality upgrade, needs a key.
- Live Slack/Google/Azure connector readiness — unrelated, still gated.

The whole audio video-search experience is demonstrable offline.
