# Missed-call callback (dev only)

The AI (GPT-Live, `gpt-live-1`) calls back someone whose call the owner missed, speaks first, takes their
name, reason and message, and hangs up. After the call, the transcript can be turned into a short summary
for the owner. Today it runs only on a laptop (browser mic and speakers). Nothing is saved to a database.

## Files
- `route.js`: dev HTTP/WebSocket server: the stream socket, the summary endpoint, the test page.
- `session.js`: one call: source → GPT-Live → sink. Speak-first nudge, barge-in, silent-caller prompts, 5-min cap, in-memory transcript.
- `prompt.js`: the AI's instructions and its fixed lines (opening, silence prompt, goodbye, wrap-up). Tone rules come from `../gptLive.js`.
- `summary.js`: `summarize(transcript)` and `summarizeSession(session)`: one model call, fixed JSON schema, checked against the transcript.
- `laptopSource.js` / `laptopSink.js`: caller audio in from the browser socket / AI audio back out to it.
- `exotelSource.js` / `exotelSink.js`: stubs that throw "not configured".
- `devpage.html`: browser test page (mic, playback, live transcript, "Get summary").
- `../../../scripts/missedcall-test.js`: replays a WAV as the caller and prints transcript, timings and summary.

## Endpoints
All three are on the dev server: `http://127.0.0.1:<MISSED_CALL_DEV_PORT || 3001>`, bound to 127.0.0.1 only.

**WebSocket `/ai/missed-call/stream?source=laptop`**
- `source=exotel` closes with 1011 "exotel source is not configured"; any other path or source gets HTTP 400.
- Auth: a session JWT in the first message, checked with `verifySession` (`middleware/auth.js`). Skipped when `AUTH_DISABLED=true`.
- From the browser: text `{"type":"start","token","callerName"?}` within 10 s (else close 1008); binary mic audio; text `{"type":"stop"}` to hang up.
- From the server: text `{"type":"ready","id","voice","format","maxSec"}`; binary AI audio; text `{"type":"transcript","role","delta"}`;
  text `{"type":"clear"}` (drop queued audio, barge-in); text `{"type":"ended","reason","errors","transcript"}`, then the socket closes;
  text `{"type":"error","error"}` before a refusal.
- Limits: 2 calls at once (else close 1013), 256 KB per message.
- Set by the server, not the browser: session id, model, instructions, audio format, the 5-minute cap; the voice (owner's
  `assistant.voice` through `gptLive.voiceFor`, default `gleam`); the owner name (profile `user.name` from `users/context.getProfile`, else "the owner").

**POST `/ai/missed-call/summary`**
- Auth: `Authorization: Bearer <JWT>`, skipped when `AUTH_DISABLED=true`. A session is summarized only for its own owner.
- Body (up to 256 KB): `{ "sessionId": "mc_…" }` (a finished call still in memory; the summary is kept on that session),
  or `{ "transcript": [...] }` in the format below (summarized, not kept).
- Returns 200 with the summary or `{ "empty": true, "reason" }`; 400 bad body or transcript; 401 bad token; 404 unknown call;
  409 call not ended; 413 body too large; 502 `model_failed`/`summary_invalid`; 503 the session check failed.

**GET `/dev/missed-call-test`**
- The test page. No auth to load it; you paste a token into the page if auth is on.

## Data formats
- **Audio, both directions:** raw PCM, signed 16-bit little-endian, mono, 24 000 Hz (`session.js` `FORMAT`). One format for in and out.
- **Browser frames:** binary WebSocket messages of any whole-sample length up to 96 000 bytes (2 s). The page sends 100 ms (4 800 bytes).
- **Transcript** (in memory, `session.transcript`): `[{ role: "caller"|"assistant", text, atMs, interrupted? }]`; `atMs` is ms since
  the session started; the caller's words come from GPT-Live's transcript; the nudge's own "Hello?" is left out.
- **Session object:** `id, state, startedAt, endedAt, endReason, voice, transcript, bargeIns, errors, usage, uid`, plus `summary` once
  made. The route keeps the last 20 ended sessions; all lost on restart.
- **Summary JSON:**
  - `summary`: 2–5 English sentences to the owner;
  - `caller_name`, `callback_number`, `urgency` (low/normal/high), `callback_requested`, `ai_commitments[]`, `reply_message` (in the caller's language), `language`;
  - `ai_committed`: true if the AI promised anything for the owner;
  - `_meta { model, requestedModel, attempts, ms, warnings, generatedAt }`.
  - If the caller said fewer than 2 words, it returns `{ empty: true }` and calls no model.

## Config
- `MISSED_CALL_DEV_PORT`: dev server port, default 3001.
- `MISSED_CALL_SUMMARY_MODEL`: the summary model. Default: `OPENAI_SMART_MODEL`, else `gpt-4.1`. When that model is busy, `router.generateReply` may fall back to `OPENAI_FALLBACK_MODEL` (default `gpt-4.1-mini`).
- Voice model: `gpt-live-1`, fixed in `gptLive.MODEL`.
- The speak-first "Hello?" nudge: made once per process with `openai.speak`, i.e. `OPENAI_TTS_MODEL` (default `gpt-4o-mini-tts`), `OPENAI_TTS_VOICE` and `VOICE_ACCENT`.
- `OPENAI_API_KEY`: required for calls and summaries. `JWT_SECRET` and `DATABASE_URL`: for the token check and the owner's profile.
- `MISSED_CALL_TOKEN`: test script only; same as `--token`.
- **Gating:** `server.js` starts the dev server only when `NODE_ENV !== "production"`; `route.listen()` also returns null in
  production and each handler re-checks. `.env` is loaded by dotenv, so a `NODE_ENV` set there applies.
  `AUTH_DISABLED=true` skips the token check everywhere here; the owner profile is then null.
- Tuning constants at the top of `session.js`: `SILENCE_FIRST_MS`/`SILENCE_SECOND_MS` (2 s each), `VOICE_RMS` 700,
  `VOICE_MIN_MS` 150, `BARGE_QUIET_MS` 500, `NUDGE_*`.

## Placeholders to replace for Exotel
Nothing about Exotel below is verified. **Verify everything against Exotel's docs.**
- **`exotelSource.js` `exotelSource()`:** must accept Exotel's media connection and provide `start()`, `onAudio(cb)`, `stop()`,
  handing PCM16 24 kHz chunks to `cb`. Needs from Exotel's docs: who opens the connection; its auth/signature check; the
  start/media/stop event names and the field carrying audio; the encoding and sample rate.
- **`exotelSink.js` `exotelSink()`:** must provide `sendAudio(chunk)`, `clear()`, `close()`. Needs from Exotel's docs: the
  play-audio message and its format; whether a "flush queued audio" message exists for `clear()` (unknown); how our side hangs up.
- **Resampling:** `session.js` assumes PCM16 24 kHz everywhere: `FORMAT`, `BYTES_PER_MS`, `FRAME_BYTES`, voice detection
  (`callerVoice` reads PCM16) and the "Hello?" nudge (24 kHz PCM16). Either resample Exotel audio to and from 24 kHz PCM16 in the source and sink, or switch GPT-Live to a format Exotel sends. GPT-Live also takes `audio/pcm` 16000 and `audio/pcmu`/`audio/pcma` 8000; changing `FORMAT` means updating all of the above.
- **`route.js` `SOURCES.exotel`:** already wired to the two stubs. It still needs the Exotel auth check.
- **Dialing the caller back through Exotel's API:** no code yet; the endpoint and fields are unknown, so verify against Exotel's docs.
- These are the only `TODO`s in the folder.

## Not built yet
- Saving the call and summary to the database (`call_records`); today everything is in memory only.
- Pushing the summary to the owner.
- The missed-call trigger from the app, i.e. what starts a callback.
- Exotel media (stubs above) and Exotel dialing.
- Moving the stream onto the main port: `ai/gone.js` `attachUpgrade` destroys every WebSocket upgrade except `/live/ws`, so this runs on its own port.
- Production gating: auth, rate limits and abuse limits for a public route. Today it is dev-only, on 127.0.0.1.
- Automated tests: none in the repo; `npm test` and `test:all` don't cover this folder.

## How to test
- **Server and page** (needs Postgres and the usual `.env`):
  ```
  NODE_ENV=development npm start
  # open http://127.0.0.1:3001/dev/missed-call-test → Start → talk → Stop → Get summary
  ```
  Use headphones: speaker echo can trigger barge-in. Leave the token empty if `AUTH_DISABLED=true`.
- **Replay a WAV as the caller** (real OpenAI calls, a few cents; starts its own dev server on a free port):
  ```
  NODE_ENV=development npm run e2e:missedcall -- caller.wav [--out out.wav] [--timeout 90] [--token <JWT>] [--name "Anil"] [--no-summary]
  ```
  It prints the transcript, start→first AI audio, end of WAV→first reply, barge-ins and the summary, and saves the AI audio to `out.wav`.
- **Summary only:**
  ```
  curl -X POST http://127.0.0.1:3001/ai/missed-call/summary -H "Content-Type: application/json" \
    -H "Authorization: Bearer <JWT>" -d '{"sessionId":"mc_..."}'
  ```
