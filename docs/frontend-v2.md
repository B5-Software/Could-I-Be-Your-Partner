# Youth and Professional interfaces

Choose **Settings → Appearance → Interface style → Professional** (专业). Youth (青春) remains the default. Internally the existing values `v1` and `v2` remain compatible with saved settings. Switching applies immediately and is saved as `theme.frontend` in the shared settings backend. GUI and WebUI receive the same preference through settings events; no reload is required. TUI exposes this preference in its shared settings catalog, although the desktop layout does not change the terminal UI.

Professional defaults to a 1280px content width and compact density. Appearance settings adjust the width between 720 and 1920px, with compact, comfortable and spacious densities. Messages, tool cards and composers share the chosen width; small screens adapt automatically. Password visibility buttons retain their SVG icon across login-page translations, and the blank titlebar area remains draggable while interactive controls stay clickable.

The composer opens a capability-based reasoning slider with a reset button and a searchable model-pool picker. Both controls persist session overrides through the shared backend, protect running tasks and keep the global default unchanged. Pending attachments appear as compact filename/type/size cards inside the composer; switching shells moves the same preview nodes without losing handlers. Native attachment-source and file dialogs use viewport centering.

Message management supports multi-selection and an explicit preview of related replies/tool messages. The default deletes both transcript and raw context; an optional scope only removes context and marks retained transcript entries as excluded. Message hover actions and context menus offer direct deletion of a message/turn or its following messages, with a small confirmation instead of the full management list. Busy tasks can be stopped explicitly from that confirmation. Live optimistic and streamed bubbles receive backend-assigned IDs after admission, so duplicate text is never resolved by message position. Unaffected system/context prefixes remain byte-identical, and working-state exports retain exclusions across reloads. Existing summaries are retained and clearly disclosed because their merged contents cannot be precisely erased. Destructive edits are acknowledged after an atomic history write; failures restore the shared in-memory state.

The search surface is anchored inside the active message pane below its header, including the Code sidebar and narrow windows. The reasoning control uses continuous pointer movement with animated snapping, keyboard steps and a serialized latest-value save queue. Unchanged appearance notifications do not close it. Its fill/thumb transitions obey the shared animation switch and reduced-motion preference, and controls retain their preview while a save is pending.

Automatically created workspaces are tracked separately from user-selected projects. `renameWorkspace` names owned artifact storage independently of conversation titles and retains a stable path alias so tool references and admitted prompt prefixes remain usable. A durable rename journal recovers an interrupted rename. Windows uses junctions and falls back to a semantic alias if live storage is locked. Imported VM projects retain their guest identity and host mapping. Startup/shutdown cleanup uses non-recursive removal of owned empty directories, protecting chats, artifacts and active tasks. Conservative legacy adoption requires a readable history scan and a generated directory name. Model prompts require naming saved artifacts; one bounded reminder catches an omitted name without looping indefinitely.

V2 uses a compact outline navigation rail, a resizable and collapsible session sidebar, workspace information and neutral light/dark surfaces. New conversations place the CIBYP wordmark directly above the composer, with the selected model inside its toolbar and quick actions below. Once a conversation begins, the same composer returns to the bottom. Open sessions are excluded from earlier history so the sidebar does not repeat them. On narrow screens the session sidebar becomes a drawer. The existing accent, background, fonts, focus and animation preferences remain shared.

## Shared components, independent shells

`src/renderer/core/frontend-shell.ts` owns layout, sidebar geometry, recent history presentation and shell-only controls. `src/renderer/css/frontend-v2.css` scopes V2 styles under `html[data-frontend="v2"]`.

Both shells use **the same page elements, inputs, controllers, backend Agent views and feature APIs**. V2 reparents the original mode selector, navigation and session tabs. Comment anchors restore their exact V1 locations. Feature pages remain direct children of `#main-content`, retaining the navigation, inert/focus rules and all original event handlers. No alternate HTML page, copied settings screen, second Agent loop or parallel backend is introduced.

Composer inputs, attachments, media capture, approval queues, ongoing requests and native Code-OSS surfaces are not reconstructed when switching interfaces. Babe's original input and buttons move into a shared-style composer surface; welcome quick actions move below the Chat composer. Comment anchors return these same nodes to V1 without losing their listeners or drafts. Session tabs retain their original activation, close, status, context menu, preview and ordering behavior. Drag/drop uses the horizontal axis in V1 and the vertical axis in V2. Keyboard navigation follows the same orientation.

Sidebar history calls the existing per-mode history APIs. Opening an already live session activates its current Agent view instead of loading an older persisted snapshot. Closed sessions use the existing history continuation handlers. Code history remains scoped to its current workspace; V2 does not create another history store. Titles are inserted as text, not HTML. Only 30 recent rows are shown; the full history page and content search remain available.

Sidebar width and collapse state are local geometry preferences. Mode, session, settings, workspace and task state retain their existing ownership. A native Code-OSS view is hidden while a narrow-screen sidebar drawer covers it, just as it is hidden for shared modal dialogs.

## Feature preservation and checks

| Feature group | Shared implementation | Verification |
| --- | --- | --- |
| Chat, sending, stopping, reasoning, Markdown, attachments, approval and task cards | Original Chat controller and DOM | Native backend inference continues through a shell switch; original controls retain identity; draft retained; existing desktop/backend tests cover conversations and cards |
| Code, workspace, editor, terminal, extensions, AI panel, changes and immersive mode | Original CodeOSSController, CodeAgentPanel, native Code-OSS host | Code Agent and draft retained; immersive exit remains reachable; optional native run verifies a connected editor, workspace file, terminal command and viewport bounds |
| Babe, relationship, activities and history | Original Babe Agent/controller and DOM | New sessions, draft preservation, relationship panel and sidebar navigation; existing Babe relationship integration suite |
| History and session operations | Original SessionManager and history handlers | V1/V2 round trip, keyboard navigation, filtering and original tab/status/context-menu controls |
| Tools, skills, knowledge, memory, automation, about | Original pages and loaders | Every shared page remains connected and navigable; existing feature suites continue to run against the same controllers |
| Settings, model pool, providers, assistant, updates, Remote, VM, voice and camera | Original settings pages, catalog, IPC and browser APIs | All settings destinations are navigable; the new field appears in the common catalog; existing feature suites validate their backend operations |
| WebUI | Same HTML, bundle, styles and independent renderer against shared backend | Authenticated browser bootstrap, hot preference propagation to GUI and browser draft retention |
| Theme, localization and responsive behavior | Shared ThemeManager and i18n; scoped shell styles | Light/dark, custom accent, Chinese/English/German shell text, narrow drawer, unclipped send control, no document/chat horizontal overflow |

Run `npm run test:frontend` for the isolated GUI/WebUI shell suite. Its IDE boundary is a fixture so CI does not need to download Code-OSS. Run `npm run test:frontend:native` separately to prepare and exercise the real Code-OSS runtime, viewport bounds and drawer occlusion. Browser checks run in the first suite, independently of the native IDE's Electron navigation hooks. Screenshots are written under `.cache/screenshots/frontend-*.png`; the native editor has its own capture in addition to the DOM shell.

`npm run check` remains the lint, format, TypeScript, unit and legacy gate. `npm run test:backend:v2` exercises the full existing shared-backend integration suite with V2 enabled, including attachments, compaction, update notices, browser terminals and auxiliary editors. The Windows desktop CI runs both this and the GUI/WebUI shell suite.

## Design references

- [OpenCode application shell](https://github.com/anomalyco/opencode/blob/dev/packages/app/src/shell/shell.tsx)
- [OpenCode persisted layout state](https://github.com/anomalyco/opencode/blob/dev/packages/app/src/shell/state/layout.tsx)
- [OpenCode composer](https://github.com/anomalyco/opencode/blob/dev/packages/app/src/composer/composer.tsx)
- [OpenCode new-session layout](https://github.com/anomalyco/opencode/blob/dev/packages/app/src/new-session/view.tsx)
- [OpenCode theme tokens](https://github.com/anomalyco/opencode/blob/dev/packages/ui/src/styles/tokens/theme.css)
- The supplied Codex Desktop screenshot guides the compact navigation, neutral hierarchy and centered input layout. Codex Desktop's private UI implementation is not claimed as an inspected source.

The implementation reuses CIBYP components; it does not copy the OpenCode application or its branding.
