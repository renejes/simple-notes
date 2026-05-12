# Next Steps

Roadmap items, ordered by user priority and implementation logic. Read
`project-status.md` first for context.

## 1. Deployment — Hetzner VPS + Nextcloud WebDAV ★ priority

This is the major remaining piece. The Vite middleware that currently acts
as the file-I/O backend needs to be **replaced by a browser-side WebDAV
client** in production, so the user can deploy the static frontend on a
Hetzner VPS and have it talk directly to a Nextcloud instance.

**Goal architecture:**

```
[iPad / Mac browser]
        │
        │  static HTML/JS (Vite-built)  ←─ Caddy / nginx on Hetzner VPS
        │
        │  WebDAV requests with Basic Auth (Nextcloud App Password)
        ▼
[Nextcloud /Notes/ folder]
```

**What needs to happen:**

- [ ] Add a configurable backend abstraction. Right now `App.tsx` and the
      various helpers hit `/api/…` paths directly. Either:
  - (a) Introduce a thin `storage` interface (`readTree`, `readFile`,
        `writeFile`, `delete`, `rename`, `upload`, `search`, `backlinks`,
        `tags`, `trash`, `tasks`, `headings`) and have two implementations:
        `viteApi` (current) and `webDav` (new), chosen at build-time via env
        var.
  - (b) Or rewrite `vite.config.ts`'s middleware as a separate tiny Node
        server that the VPS runs alongside Caddy, so the frontend stays
        identical. Simpler but adds an extra hop and a second deploy unit.
  - Recommendation: **(a)**. WebDAV-direct from browser is the user's
        stated goal.
- [ ] Implement `WebDAVStorage`. Use [webdav](https://www.npmjs.com/package/webdav)
      npm package OR hand-roll PROPFIND/GET/PUT/MOVE/DELETE. Backlinks /
      search / tags / tasks / headings will need to be implemented
      client-side (walk the file tree, fetch each `.md`, scan). For 100s of
      notes this is fine; for 1000s consider caching an index in
      localStorage / IndexedDB and invalidating per-file on save.
- [ ] Decide how to do **authentication**. Easiest: prompt user for
      Nextcloud URL + username + app-password on first launch, store in
      localStorage (or use the browser's HTTP Basic Auth dialog). Nextcloud
      app-passwords are revokable per-device.
- [ ] CORS: Nextcloud's WebDAV endpoint must allow browser requests from
      the app's origin. Either configure Nextcloud's `app_security_policy`
      or proxy WebDAV through Caddy on the same origin as the frontend (no
      CORS needed).
- [ ] Caddy / nginx config: serve the Vite-built `web/dist/` as static
      files with HTTPS via Let's Encrypt, plus reverse-proxy
      `/webdav/*` → Nextcloud's `/remote.php/dav/files/<user>/` if going
      the same-origin route.
- [ ] Test the GC equivalent client-side, OR move GC into a periodic
      server-side cron job that the user runs on the VPS.

**Tricky bits to watch:**

- WebDAV listing doesn't expose `mtime` in a uniform way across servers.
  Nextcloud supports `<getlastmodified>` PROPFIND property — fine.
- Large PDF uploads via WebDAV PUT can hit Nextcloud chunk-size limits.
  Probably fine for typical PDFs but worth testing.
- The handwriting save sequence currently does three parallel uploads
  (PNG/SVG/JSON). WebDAV handles them; just ensure each completes before
  the editor block is inserted.
- Soft delete: re-implement as a `.trash/` move via WebDAV `MOVE`. Restore
  works the same.

### MCP server during/after Hetzner migration

The MCP server currently runs locally on the user's Mac and reads the
notes folder via direct filesystem access (`NOTES_ROOT` env var). When the
notes move to Nextcloud-on-Hetzner, **the MCP server config in Claude
Desktop must be updated**.

Two viable patterns:

**(a) Keep MCP server local, point at Nextcloud-synced folder.** Recommended.
The user already runs Nextcloud Desktop client locally for sync, which
mirrors the remote `Notes/` folder to a local path (e.g.
`~/Nextcloud/Notes/`). Update the Claude Desktop config to:

```json
{
  "mcpServers": {
    "notes": {
      "command": "node",
      "args": [
        "/Users/renejesser/Desktop/Programming - Projekte/notes-app/mcp-server/dist/index.js"
      ],
      "env": {
        "NOTES_ROOT": "/Users/renejesser/Nextcloud/Notes"
      }
    }
  }
}
```

Adjust both the `args` path (if the repo moves) and the `NOTES_ROOT`
(swap the local `notes-app/notes` for the Nextcloud-synced location).
No code changes needed — the MCP server is filesystem-agnostic.

**(b) Run the MCP server on Hetzner with WebDAV access.** Not recommended
for v1: MCP stdio transport doesn't trivially go over a network, and
Claude Desktop's `command` runs locally. You'd need to either:
- Add a tunnel (ssh -L) so Claude Desktop spawns a local process that
  pipes to a remote one, or
- Switch to MCP HTTP/SSE transport (newer in the SDK) and host the server
  on Hetzner behind auth.
The local + Nextcloud-synced approach (a) is simpler and just as fast.

In either case, also bump `NOTES_ROOT` references in any scripts / docs
that hardcode the path.

## 2. Service Worker — offline editing of recently-opened notes

Once deployed, the user might want to read/edit on the iPad even with
flaky Wi-Fi. Plan:

- [ ] Cache the app shell (HTML, JS, CSS, icons) — gives fast cold start
      and lets the app open even fully offline.
- [ ] Cache recently-opened notes' MD content + their attachments in
      IndexedDB.
- [ ] Queue writes when offline; replay them when connection returns.
      Conflict policy: last-write-wins with a visible "remote was newer,
      yours overrode" warning (or merge UI — but that's a whole separate
      feature).
- [ ] Use [Workbox](https://developer.chrome.com/docs/workbox/) or the
      `vite-plugin-pwa` package — both abstract the service-worker
      lifecycle correctly.

Defer until after deployment is live and the user actually feels the
offline pain.

## 3. Code-block syntax highlighting

BlockNote's default code block renders mono but no syntax highlighting.
Two options:

- [ ] **Shiki** — VS-Code-grade highlighting, large bundle (~1MB) but
      gorgeous. Render-once on save, store HTML in the block. Some
      complexity to integrate with BlockNote's editing model.
- [ ] **Prism.js** or **highlight.js** — smaller, simpler, less pretty.

Recommendation: Shiki via the [`@blocknote/code-block`](https://www.npmjs.com/package/@blocknote/code-block)
plugin if it exists for 0.50, otherwise skip until the user actually
pastes code into a note. User has indicated this is not a priority.

## 4. Note templates

When creating a new note via "+ Notiz", optionally seed it from a template.

- [ ] Add a `notes/.templates/` directory; gitignore it the same as `notes/`.
      Each file in there is a template (with frontmatter).
- [ ] Modify "+ Notiz" flow: if templates exist, the prompt becomes a
      small dialog (name + optional template picker). Without templates,
      behavior unchanged.
- [ ] Bonus: `{{date}}`, `{{title}}` placeholder substitution at create
      time.

User has indicated this is not a priority.

## 5. Smaller polish items

- [ ] Better empty-state when no notes exist (currently fairly bare)
- [ ] Tag-rename: clicking on a tag in the tag panel could offer "rename
      this tag globally" → find/replace `#oldtag` across all `.md` files
- [ ] Image resize handle (similar trade-off to the PDF size buttons —
      maybe just three presets again)
- [ ] Frontmatter editor — a small `<details>`-style block above the editor
      letting the user edit raw YAML if they want
- [ ] Manual dark-mode toggle (currently follows system preference)
- [ ] Keyboard shortcut help dialog (`?` key)
- [ ] MCP: expose `delete_note` / `trash_note` (currently read+write only,
      no delete — intentional safety, but Claude might benefit from it)
- [ ] MCP: expose `list_pinned_notes` and `set_pinned(path, true|false)`
- [ ] MCP: expose `list_recent_notes(limit)` mirroring the palette's
      recent-list (would need to persist recent state to disk or have MCP
      derive it from `modified` mtime)

## 6. Done — moved out of the roadmap

These were on previous roadmaps and are now implemented:

- ✅ Drag-drop folder tree reorder — implemented as **Move-via-modal**
  instead (HTML5 drag-drop kept conflicting with text-selection; modal is
  more reliable on touch)
- ✅ Export single note as PDF (browser print) and standalone HTML
- ✅ Word count + reading-time estimate
- ✅ Outline panel for the current note
- ✅ Pinned notes (sidebar section + `pinned: true` frontmatter)
- ✅ Task aggregator (sidebar + `/aufgabe` slash command for inserting
  a check-list block)
- ✅ Internal heading anchors (`[[Note#Heading]]`)
- ✅ MCP server for Claude Desktop integration

## 7. Things we deliberately DON'T plan

- Multi-user / collaboration — single-user is a feature, keeps things
  simple
- Cloud sync as a service — the on-disk MD format means BYO Nextcloud /
  Syncthing / iCloud Drive works for free
- Native iOS app — the PWA-on-iPad story is the iOS story
- Plugin system — out of scope for a personal tool

## Handoff notes for a fresh chat

If picking up this project in a new conversation:

1. Read `Documentation/project-status.md` first (sibling file) for
   architecture, conventions, and known footguns.
2. The biggest land-mines: schema changes need full page reload, slash-menu
   `title === group` causes duplicate-key warnings, PDF size encodes in URL
   query and the GC must strip it, PDF blocks need `flex-shrink: 0` to
   honor explicit widths inside BlockNote's flex wrappers.
3. Custom blocks / inline content go through the schema export in
   `web/src/pdfBlock.tsx` — that file aggregates all of them even though
   its name suggests PDF-only.
4. The MCP server is in `mcp-server/`. It's independent of the web app;
   both share `notes/` as source of truth. When Hetzner deployment lands,
   update `NOTES_ROOT` in Claude Desktop's config to the Nextcloud-synced
   local path (and `args` if the repo moves).
5. The user prefers concise, action-oriented responses in German. Build
   working features over discussing alternatives. They're a senior dev
   doing music mixing professionally — comfortable with technical detail
   but values pragmatism over architecture astronautics.
