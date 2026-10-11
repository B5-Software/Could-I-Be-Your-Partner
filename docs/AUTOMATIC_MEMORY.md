# Automatic conversational memory

Automatic memory runs alongside the existing tool-managed long-term memory. It does not migrate or modify `memory.json`, transcripts, or persisted compaction summaries.

## Controls

Open **Settings → Automatic memory** in the desktop App or WebUI. The master switch pauses capture and recall without deleting stored memories. A separate capture switch permits recall without learning new facts. Chat, Code and Babe have individual switches. The same options appear in the shared TUI `/config` catalog.

Search, edit, delete or clear memories in settings. Manual edits are protected from automatic updates. Deletes leave bounded hashed suppression markers; ordinary conversation cannot immediately recreate the same deleted topic. An explicit “remember” request can reintroduce it. Deleting a chat does not automatically delete a separate automatic memory.

## Data flow

1. The shared Agent passes explicit human message text to the host service, including hot user messages. Attachments, tool outputs, assistant reasoning, generated continuations and proactive prompts are excluded. Ephemeral settings-assistant sessions neither contribute nor recall.
2. A serialized, one-second debounced queue extracts durable facts, preferences and ongoing goals using the conversation’s model and connection. It uses the existing host inference transport, format adaptation, free-model compatibility and spending controls. No embedding provider or additional credentials are needed.
3. Structured records require an exact supporting quote from the submitted user text. Unknown IDs, ungrounded records, credentials and malformed responses are rejected. The prompt excludes sensitive personal topics, fiction, quotes and transient tasks. Extraction remains probabilistic; review and correction are available in settings.
4. The next Agent step recalls a bounded selection using local text relevance and durable personal preferences, without a retrieval model request. Current instructions take precedence; memories are contextual data, not executable instructions.

Chat personal context is shared with Code. Code project records are isolated by canonical workspace identity. VM imports resolve to their host workspace so switching execution location preserves identity. Babe uses a separate memory space.

## Persistence and concurrency

The host owns `data/automatic-memory.json`. GUI, TUI, WebUI and remote clients share the IPC/backend capabilities and event stream. Writes atomically replace the file with restrictive permissions where supported. Unreadable storage fails closed; explicit clearing preserves an unreadable backup before reset.

Each change has a revision. Concurrent edits require a fresh revision rather than overwriting another frontend’s changes. Edits, deletes and policy changes invalidate queued/in-flight writes; disabling and re-enabling cannot commit stale extraction. Events carry revision/status only, not memory text or credentials.

Recall is transient request context: counted in token estimates, excluded from transcript/snapshot persistence and compaction replay, replaced at safe Agent boundaries, and revoked on the next step after settings changes. This cannot erase facts already mentioned in replies or supplied in a transcript.

## Bounds and costs

- At most 200 active records, each limited to 600 characters; at most 5 candidate writes per extraction.
- At most 24 pending conversations; hot messages coalesce.
- Input is bounded relative to the selected context window. Long messages use head/tail excerpts. This is not a full conversation archive.
- Output is capped at 1,200 tokens, or less for small context windows. One inference attempt, 30-second timeout; no automatic retry loop.
- Recall has a 2,200-character ceiling and a 5% context-window character allowance, included in the normal context budget.
- Extraction creates additional model usage, recorded under existing provider usage and spending controls. Retrieval is local.

## Research

These public product documents informed the behavior, not assumptions about private implementations:

- [OpenAI: Memory in ChatGPT](https://help.openai.com/en/articles/8590148-memory-in-chatgpt): cross-conversation context, separate saved memories, review/edit/delete controls and temporary-chat exclusions.
- [Anthropic: Claude chat search and memory](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context): automatically maintained topics, project isolation, corrections and pause/reset controls.

CIBYP uses a local structured store, background extraction and bounded local retrieval. It does not search unrestricted old transcripts or send complete histories to a separate memory service.

## Verification

`node --test tests/unit/automatic-memory.test.cjs` covers separate persistence, cross-session recall, isolation, switches, edit/deletion races, suppression, privacy filtering, grounded output, request bounds, transient context and the shared facade.

After `npm run build-app-bundle`, run `electron tests/integration/automatic-memory.cjs` for a real host Agent loop, backend-client sharing, GUI editing, live settings, English/German labels and screenshots. The isolated fixture uses deterministic model transport, without the user’s credentials or paid quota.
