# Computer Use and bounded tool discovery

## macOS desktop control

Computer Use now uses a Node-API bridge inside the Electron main process for
ApplicationServices accessibility (AX) and CoreGraphics input (CG). It does not
launch `osascript` or ask System Events to enumerate UI elements. Native UI tree
traversal runs in a worker, with a global node/depth/time bound. Keyboard text is
posted as Unicode without replacing the user's clipboard.

Previously, `libnut-darwin/permissionCheck.js` requested Accessibility access
whenever its cached grant was false, and UI-tree failures automatically opened
System Settings. The App's one-time startup marker did not govern either path.
The new macOS path does not load nut-js. Startup, status checks and tool calls
never request permissions or open settings. Only explicit setup buttons can do
that; request markers are persisted per executable path and permission kind.
Grants are checked again on each operation, including CG event-posting access.
Missing grants return structured failures instead of reporting an input event as
successful after the OS discards it.

Tools → Computer Use provides current Accessibility/screen recording/input status,
the exact executable needing permission, request/settings buttons and a recheck.
Installed CIBYP and development Electron have different permission identities.
macOS may require exiting/reopening the application after a grant changes. Signing
identity changes can also invalidate OS grants; this code cannot grant TCC access
on the user's behalf.

Every pointer action accepts screenshot-local pixels by default. The same
conversion uses actual screenshot dimensions and the selected display's origin,
mapping Retina pixels to desktop points. `coord_space: physical` uses native
desktop coordinates (points on macOS, pixels on Windows/Linux). UI-tree element
centers already use native desktop coordinates. Invalid display IDs/coordinates
and stale element IDs fail explicitly. Drags and chords release held input in
`finally`; double clicks carry the correct macOS click count. Input operations
from concurrent sessions are serialized.

VM routing remains the first branch. VM operations neither inspect nor request
host permissions, and failures never fall back to host input. VM UI-tree/OCR
limitations are reported explicitly; the existing guest screenshot/input path
continues to operate inside the guest.

`npm run build:computer` builds the Node-API module on macOS; `npm start` and the
macOS packaging hook also build it. Builds on other platforms skip the bridge.
Packaging fails if the native module is absent. CI now builds and loads the actual
module on Intel and Apple Silicon, both in Node and Electron. Windows tests cover
permission/routing/coordinate/input contracts using mocks; they do not demonstrate
successful control of a real macOS desktop. Native interactive testing must be
performed on a Mac with the appropriate OS grants.

Primary references: [Apple AX API](https://developer.apple.com/documentation/applicationservices/1462085-axuielementcopyattributevalue),
[CG event posting preflight](https://developer.apple.com/documentation/coregraphics/cgpreflightposteventaccess%28%29?language=objc),
[CG input events](https://developer.apple.com/documentation/coregraphics/cgevent/post%28tap%3A%29?language=objc),
[Electron system preferences](https://www.electronjs.org/docs/latest/api/system-preferences).

## Rich tools without shipping the full catalog every turn

`toolExposure.mode` defaults to `adaptive`; `all` is available in Tools for users
who need every definition exposed simultaneously. The default schema envelope is
4000 estimated tokens, additionally capped at 20% of the configured context limit.
Estimates use the existing JSON-character/4 convention, not a provider-specific
tokenizer or a guarantee of the final invoice. Small catalogs fitting the envelope
are sent directly and incur no discovery overhead.

All enabled tools remain in a local registry, including dynamically registered MCP
and imported plugin tools. Only common file/search/todo/terminal tools plus three
discovery functions are initially advertised:

- `searchTools`: local name/category/capability search, with pagination; loads
  matching original schemas for the next provider request.
- `describeTool`: paginated original parameters or a specific JSON-pointer section.
- `invokeTool`: calls a previously discovered tool using its original JSON object
  arguments; allows even an oversized MCP schema to remain reachable.

Search does not make a separate selection-model request. The primary agent may
need a tool-search turn; this does not make reasoning/output tokens free. Model
costs still depend on actual usage, provider cache behavior and the task.

The existing **automatic tool selection (System One)** preference remains independent
of **on-demand loading**. When enabled, System One makes one category-relevance decision
at the first task boundary and warms likely tools in priority order within the
same schema envelope. Code mode also supports this preloading. System One receives a
short category/task description, not full tool schemas. Missing/low-confidence
decisions fall back to local candidates in adaptive mode, never a second
full-catalog LLM call. `searchTools` supplies capabilities System One missed. The manual
reoptimization button remains available; settings do not silently turn System One off.

Tool preferences and grants are persisted as field patches, so changes do not
overwrite concurrently edited System One/loading/budget preferences with old snapshots.
Changing optimization settings invalidates outstanding selection results for all
live agents; a stale System One reply cannot reinstate the previous selection.

Stable insertion order is retained while schemas fit. Under budget pressure the
least recently used definitions are evicted; capabilities remain discoverable.
Disabled/revoked tools and configuration-gated tools are removed at each safe
provider boundary. A small category directory is admitted with runtime context
updates rather than repeating hundreds of names and definitions in the prompt.
Loaded schemas and their costs count toward context compaction before a request.

For the current built-in catalog, without additional MCP servers, the local
measurement with automatic preloading switched off is:

| Mode | Built-in tools | All definitions (estimated tokens) | Initial adaptive definitions |
| --- | ---: | ---: | ---: |
| Chat | 305 | 28,931 | 1,676 |
| Code | 83 | 8,423 | 1,676 |
| Babe | 16 | 1,550 | 1,550 |

Generic invocation is resolved to its original tool **before** checking Computer
Use/Playwright grants, sensitive-tool approval and dangerous commands. It does
not grant privileges. Each sub-agent's registry is restricted to its enabled
whitelist, including generic invocation. An enabled but deferred tool can be
delegated; a disabled tool cannot. Legacy selection-model optimization remains
compatible; adaptive mode uses its System One/local prediction as bounded preloading.

The discovery design follows the general pattern described in
[Anthropic's tool-search engineering article](https://www.anthropic.com/engineering/advanced-tool-use).
This implementation uses ordinary function calling, so it works with compatible
providers without requiring their proprietary deferred-loading API.
