# Project Status — Simple Notes

_Last updated: 2026-05-11_

## What this is

A self-hosted, browser-based notes app that stores notes as plain Markdown
files on disk. Designed to slot into a personal Nextcloud / Hetzner-VPS stack
without locking data into a proprietary format. Built because no existing app
combined: typed notes + Apple Pencil handwriting in the browser + embedded
PDFs viewable at full size + wikilinks + tags + 1:1 mirroring to a Nextcloud
folder.

Repo: <https://github.com/renejes/simple-notes>

## Current status

**Local development is feature-complete for solo daily-use.** The user
considers the app functionally ready for their actual workflow. Everything
runs in a Vite dev server with built-in middleware acting as the backend
(file I/O against the local `notes/` folder). Deployment to Hetzner+Nextcloud
is the major remaining task — see `next-steps.md`.

All features below are implemented and tested:

- BlockNote-based block editor (WYSIWYG, slash commands, drag handles)
- Folder tree with unlimited nesting, create/rename/soft-delete
- Wikilinks `[[Path/Note]]` with slash-menu autocomplete, click-to-navigate
- Tags `#tag` with `#`-trigger autocomplete, click opens palette filter
- Backlinks panel under every note (server-scan based)
- `Cmd+K` command palette: title fuzzy-match + full-text search +
  "recently opened" list when query is empty
- `Cmd+Shift+D` Daily Note (`Daily/YYYY-MM-DD.md`, auto-creates with date
  heading if missing)
- PDF embedding with native browser viewer; three width presets
  (schmal/breit/sehr breit) persisted via `?size=…` URL query
- Handwriting block — full-screen modal canvas with Apple-Pencil pressure
  via PointerEvents + perfect-freehand. Saves PNG (display) + SVG (vector
  portability) + JSON (raw strokes) sidecars sharing one UUID. Re-edit loads
  the JSON back into the modal for lossless modification
- Image embedding (drag-drop or slash menu)
- YAML frontmatter auto-managed on save (`created`, `modified` stamps)
- Sort tree by name (asc/desc) or modified (newest/oldest) — folders always
  alphabetical first, files by chosen sort
- Soft delete: items move to `notes/.trash/<timestamp>__<encoded-path>`,
  restored via modal listing. GC scans `.trash/` so trashed notes' attachments
  are preserved for restore
- Attachment garbage collection — runs after every save and delete, removes
  unreferenced files in `_attachments/` (stripping `?size=…` query before
  comparing)
- URL-based routing (`?path=foo/bar.md`); `Cmd+Click` on tree entries / Cmd+K
  results / wikilinks opens in new tab natively
- Mobile/iPad layout: sidebar collapses below 1024px viewport, slide-in
  overlay, always-visible row action buttons (no hover on touch)
- PWA install (manifest + apple-touch-icon + theme color); standalone display
  mode

## Tech stack

| Layer            | Choice                                                                 |
| ---------------- | ---------------------------------------------------------------------- |
| Editor           | `@blocknote/{core,react,mantine}` 0.50                                 |
| Framework        | React 19 + TypeScript 6                                                |
| Bundler          | Vite 8 (with `vite:oxc` transformer — note its JSX quirks below)       |
| Drawing          | `perfect-freehand` 1.2                                                 |
| Frontmatter      | `yaml` 2.9                                                             |
| Editor font      | `@fontsource/ibm-plex-mono` 5.2                                        |
| Icon generation  | `sharp` 0.x (dev-only; build-time PNG render from SVG)                 |
| Backend (local)  | Inline Vite middleware in `web/vite.config.ts` — _no separate process_ |
| Backend (target) | Browser → WebDAV direct against Nextcloud (planned, not implemented)   |
| Node             | 24.13+ required (Vite 8 + Node 24 features)                            |

Lock file: `pnpm-lock.yaml` committed. Use `pnpm` not `npm`.

## Repository layout

```
notes-app/
├── README.md
├── LICENSE                          # MIT
├── .gitignore                       # excludes notes/, node_modules/, .claude/
├── Documentation/
│   ├── project-status.md            # this file
│   └── next-steps.md
├── web/
│   ├── package.json
│   ├── vite.config.ts               # ★ Vite plugin = backend (file API)
│   ├── index.html                   # PWA meta tags
│   ├── public/
│   │   ├── icon.svg                 # SOURCE icon — edit me
│   │   ├── icon-{180,192,512}.png   # built from icon.svg
│   │   ├── icon-maskable-512.png
│   │   └── manifest.webmanifest
│   ├── scripts/
│   │   └── build-icons.mjs          # one-shot: SVG → PNGs via sharp
│   └── src/
│       ├── main.tsx                 # entry; loads IBM Plex Mono CSS
│       ├── App.tsx                  # main shell — biggest file by far
│       ├── App.css                  # all custom styles
│       ├── index.css                # root background + font fallback
│       │
│       │ # BlockNote schema lives here:
│       ├── pdfBlock.tsx             # PDFBlock + combined schema export
│       ├── handwriteBlock.tsx       # HandwriteBlock (img + edit button)
│       ├── wikilinkInline.tsx       # WikilinkInline + rehydrate helper
│       ├── tagInline.tsx            # TagInline + rehydrate helper
│       │
│       │ # Modals & panels:
│       ├── handwriteModal.tsx       # full-screen canvas editor
│       ├── commandPalette.tsx       # Cmd+K
│       ├── backlinksPanel.tsx       # below the editor
│       ├── tagPanel.tsx             # below the tree in sidebar
│       ├── trashModal.tsx           # soft-delete UI
│       │
│       │ # Small utilities:
│       ├── upload.ts                # /api/upload helper
│       └── frontmatter.ts           # YAML parse/serialize
│
└── notes/                           # gitignored — user data
    ├── *.md                         # notes with YAML frontmatter
    ├── <subfolders>/                # arbitrary nesting
    ├── _attachments/                # images, PDFs, handwriting sidecars
    └── .trash/                      # soft-deleted entries
```

## Storage conventions

**Note files:** `notes/<arbitrary/path>.md` with optional YAML frontmatter:

```markdown
---
created: 2026-05-11T15:00:00.000Z
modified: 2026-05-11T15:32:00.000Z
---

# Note Title

…body…
```

Frontmatter is auto-managed: `created` set on first save if missing,
`modified` stamped on every save. Other frontmatter keys are preserved
on round-trip.

**Wikilinks:** `[[Path/To/Note]]` — target is the file path without `.md`.
For nested files we use the full path to avoid basename ambiguity (Obsidian
convention).

**Tags:** `#tagname` — regex `(?<![\w])#([\w][\w\-/]*)`. Lookbehind ensures
URLs (`https://x#anchor`) don't match. Headings (`# Heading`) explicitly
filtered out by the server before counting and by `rehydrateTags` which skips
heading blocks.

**Attachments:** `notes/_attachments/<filename>` referenced from MD as
`/_attachments/<filename>`. The Vite middleware serves `/_attachments/*`
with `Cache-Control: no-cache` so handwrite re-edits show fresh content
after save without manual refresh.

**Handwriting:** triple sidecar with shared UUID:

- `_attachments/handwrite-<uuid>.png` — referenced from MD via standard
  image syntax (`![](/_attachments/handwrite-<uuid>.png)`). AI-vision friendly
- `_attachments/handwrite-<uuid>.svg` — vector portability
- `_attachments/handwrite-<uuid>.json` — `{width, height, strokes: [{points, color, size}]}`
  for lossless re-edit (perfect-freehand outline is non-invertible to original
  pressure-aware centerlines)

**PDF size:** persisted in the MD URL query, e.g.
`[file.pdf](/_attachments/abc.pdf?size=wide)`. Values: `narrow`, `""`
(default = "Breit"), `wide`.

**Soft delete:** `notes/.trash/<deletedAtMs>__<urlEncodedOriginalPath>`.
Folders are moved whole. Restore moves back to the decoded original path
(appends `-restored` if a name collision occurred).

**Daily notes:** `notes/Daily/YYYY-MM-DD.md`, auto-created with a German
weekday heading when opened.

## Backend API surface (Vite middleware)

All in `web/vite.config.ts`. The Vite dev server IS the backend in dev mode.

| Method   | Path                       | Purpose                                                |
| -------- | -------------------------- | ------------------------------------------------------ |
| `GET`    | `/api/tree`                | Folder tree with `mtime` on every file entry           |
| `GET`    | `/api/file?path=…`         | Read MD file (incl. frontmatter)                       |
| `PUT`    | `/api/file?path=…`         | Write MD file; triggers `scheduleGarbageCollect()`     |
| `POST`   | `/api/dir?path=…`          | `mkdir -p` (create folder)                             |
| `DELETE` | `/api/path?path=…`         | Soft delete → moves to `.trash/`                       |
| `POST`   | `/api/rename` (JSON body)  | Move/rename file or folder                             |
| `POST`   | `/api/upload?ext=…&name=…` | Raw bytes upload to `_attachments/`; `name` optional   |
| `GET`    | `/_attachments/<file>`     | Static-serves attachments (no-cache)                   |
| `GET`    | `/api/tags`                | Sorted list of `{tag, count}` across all `.md` files   |
| `GET`    | `/api/search?q=…`          | Case-insensitive substring scan → `[{path, snippet}]`  |
| `GET`    | `/api/backlinks?target=…`  | Notes containing `[[<target>]]` → `[{path, snippet}]`  |
| `GET`    | `/api/trash`               | List trash entries with original path + delete time    |
| `DELETE` | `/api/trash`               | Empty trash (purges `.trash/`)                         |
| `POST`   | `/api/trash/restore?id=…`  | Move a trashed entry back to its original path         |

**Middleware order matters** — Vite matches by path prefix in registration
order. `/api/trash` and `/api/trash/restore` overlap; the `/api/trash`
handler checks for sub-path `/restore` and hands off via `next()`.

**GC:** `scheduleGarbageCollect()` is called after every save and delete. It
scans all `.md` files (including `.trash/`) for `/_attachments/<file>` URLs,
strips any `?query` from them, and deletes any file in `_attachments/` that
isn't in the referenced set. Handwriting triples are kept together: if the
PNG of a `handwrite-<uuid>` is referenced, the matching `.svg` and `.json`
are also kept.

## Frontend module map

```
App.tsx
├── reads/writes via /api/* endpoints
├── owns: tree state, currentPath, frontmatter, sortBy, recent[],
│          paletteOpen, handwriteOpen, trashOpen
├── Slash menu: two SuggestionMenuControllers (`/` and `#`) inside BlockNoteView
├── renders: TreeView, TagPanel, BacklinksPanel, CommandPalette,
│            HandwriteModal, TrashModal
│
├── pdfBlock.tsx — exports `schema` (combined block + inline content specs),
│   `PDFBlock`, `makePdfSlashItem`, `rehydratePdfLinks`. The schema is what
│   `useCreateBlockNote({ schema })` receives.
│
├── handwriteBlock.tsx — `HandwriteBlock` (renders <img> + Bearbeiten button),
│   `rehydrateHandwriteImages` (image → handwrite block on load),
│   `setHandwriteEditCallback` (module-level — see "JSX quirks" below)
│
├── wikilinkInline.tsx — `WikilinkInline` (custom inline content),
│   `rehydrateWikilinks` (split text containing `[[…]]`),
│   `unescapeWikilinks` (un-escape `\[\[…\]\]` that BlockNote emits),
│   `setWikilinkClickCallback`
│
├── tagInline.tsx — `TagInline`, `rehydrateTags`, `fetchAllTags`,
│   `setTagClickCallback`
│
└── frontmatter.ts — pure functions: `splitFrontmatter`, `joinFrontmatter`,
    `stampDates`
```

## Key design decisions (the WHYs)

- **Markdown on disk, not a proprietary DB.** Everything an LLM can do over
  a folder of MD files (Claude Desktop file access, grep, etc.) works
  unchanged. The editor is a view layer over the files.
- **BlockNote, not CodeMirror.** Earlier exploration of SilverBullet showed
  that no amount of theming could make a code-editor PKM feel like a notes
  app. We need a true block-based editor.
- **Custom block schema in `pdfBlock.tsx`** (not the most logically-named
  file anymore). It aggregates all custom block + inline content specs into
  the single `schema` object that `useCreateBlockNote` consumes. Each block
  type lives in its own file but the schema export is centralized.
- **Module-level callbacks instead of React Context** for `wikilink` / `tag`
  / `handwrite` click → App navigation. The reason is a Vite + `oxc`
  transformer bug: JSX member-expression tags like
  `<HandwriteEditContext.Provider>` cause "expected closing tag" parse
  errors. We worked around it with a tiny `setXxxCallback(fn)` registry
  module pattern.
- **Save is debounced 800ms, flushed on note switch.** `flushPendingSave()`
  is awaited before any navigation so no edits are lost.
- **Schema changes need a full page reload.** `useCreateBlockNote` captures
  the schema at editor creation. HMR cannot rebuild the editor's internal
  ProseMirror schema, so any change to `pdfBlock.tsx` (where the schema
  lives) requires `Cmd+Shift+R`.
- **Round-trip discipline.** Every custom block/inline serializes via
  `toExternalHTML` to STANDARD markdown that an MD-only tool can read.
  Custom rendering is reconstructed via `rehydrate*` functions in the load
  pipeline. The on-disk MD is the source of truth.

## Known quirks / footguns

- **Slash-menu duplicate-key warning.** BlockNote uses `title` AND `group`
  as React keys somewhere internally; if `title === group` you get
  `Encountered two children with the same key`. Always use distinct group
  names (`"Datei"` for PDF, `"Stift"` for handwrite, etc.).
- **PDF block flex-shrink.** BlockNote wraps every block in a flex container
  (`.bn-block-content { display: flex }`). Without `flex-shrink: 0` an
  explicit `width: 1100px` is silently ignored. We use `position:relative;
  left:50%; transform:translateX(-50%)` for centering rather than negative
  margin-left because flex-layout makes percentage margins unreliable.
- **Cache-busting handwrite re-edit.** After re-saving the same UUID, the
  browser would otherwise show the cached PNG. Two safeguards: server sends
  `Cache-Control: no-cache` for `/_attachments/`, AND the `HandwriteBlock`
  listens for a `handwrite-updated` window CustomEvent and appends `?v=N`
  to the rendered `<img src>` on each update.
- **PDF size in URL query.** GC's URL extraction must strip `?…` before
  comparing to disk filenames, otherwise `abc.pdf?size=wide` is treated as
  orphan-because-not-found.
- **Soft-delete excludes attachments.** The GC walker descends into `.trash/`
  so trashed notes' attachments survive — but the `_attachments/` folder
  itself never goes to trash; deleting an attachment via direct
  `/api/upload` cleanup is not currently supported (probably fine since
  uploads are always paired with note save).

## Build & dev commands

```sh
# Install
pnpm install                          # in web/

# Dev server (the only thing that runs in dev)
pnpm dev                              # localhost:5173
pnpm dev --host                       # expose on LAN for iPad testing

# Production build (untested in deployment yet)
pnpm build                            # produces web/dist/

# Regenerate PWA icons after editing public/icon.svg
node scripts/build-icons.mjs          # writes icon-180/192/512 PNGs

# Type checking (used to verify changes — no test suite yet)
pnpm exec tsc --noEmit
```

Vite auto-restarts on `vite.config.ts` changes. Frontend changes hot-reload
except when `pdfBlock.tsx` (schema) changes — those require a full
`Cmd+Shift+R`.
