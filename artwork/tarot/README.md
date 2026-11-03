# CIBYP illustrated tarot deck

This is a complete, card-specific 78-image generation project, replacing the geometric artwork placeholders in the tarot server UI.

- `prompts.json` records the card-specific production prompt specifications. Recreate it using `node scripts/create-tarot-prompts.cjs`. The first King of Swords was generated as the style reference before this set; its initial prompt is retained in the conversation. Subsequent cards use the recorded prompt plus the style-reference instruction in `generation.json`.
- `generation.json` records selected source outputs, the shared style-reference instruction, and exact correction prompts for revised cards.
- `originals/` preserves the selected built-in image generation outputs without creative postprocessing.
- Production assets are derived from those originals at build time: the desktop deck retains a larger image, and the firmware uses an offline, byte-budgeted deck.
- Card IDs and names remain aligned with `src/data/tarot.js`. Titles and orientation are drawn by the frontend, not generated as image text.
- Generated illustrations are not photographs of physical cards and are not scans of a third-party commercial deck.

The firmware must contain all 78 images and verify their hashes before packaging. A partial deck is unfinished work.

Build with `node scripts/build-tarot-art.cjs`, then verify with `node scripts/check-tarot-art.cjs`. The selected set contains 78 distinct illustrations. Desktop assets are 512×768 WebP; device assets are 224×336 WebP, stored in a fixed 1.875 MiB resource partition. Card captions remain outside the artwork so reversed illustrations stay unobscured.

`tests/integration/trng-webui.cjs` renders the actual offline frontend against the host-built Rust protocol core and saves light/dark/mobile and question-mixing screenshots to `.cache/previews/`. This verifies the page and protocol; it does not replace physical ESP32 radio, TRNG or USB acceptance.
