# simple-notes MCP server

An [MCP](https://modelcontextprotocol.io) server that exposes the simple-notes
vault to Claude Desktop (and any other MCP-compatible client). It reads and
writes the same on-disk Markdown notes that the web app uses — both can run
side by side.

## What you get in Claude

With this server connected, you can ask Claude things like:

- _„Welche Notizen habe ich zu `#music` mit offenen Aufgaben?"_
- _„Fass die letzten 5 Daily Notes zusammen und leg eine Wochen-Übersicht in `Daily/Wochen/`."_
- _„Welche Notizen verlinken auf `Studio Setup 2026`? Aktualisier den Backlink-Kontext."_
- _„Schreib das hier ans Ende von heute's Daily Note: …"_

Claude calls the appropriate tool, gets structured data back, and acts on it.

## Tools exposed

| Tool              | Purpose                                                   |
| ----------------- | --------------------------------------------------------- |
| `list_notes`      | List every note (optional folder filter + metadata)       |
| `read_note`       | Full content + parsed frontmatter of a note               |
| `search_notes`    | Case-insensitive full-text search                         |
| `find_by_tag`     | Notes containing a specific `#tag`                        |
| `find_backlinks`  | Notes with `[[wikilink]]` pointing at a target            |
| `list_tags`       | All tags with usage counts                                |
| `list_open_tasks` | Every open `- [ ]` checkbox across all notes              |
| `create_note`     | New note (fails on collision; auto-stamps timestamps)     |
| `update_note`     | Replace a note's body, preserving `created` timestamp     |
| `append_to_note`  | Append text to a note's body (great for Daily Notes)      |
| `today_note`      | Get/create today's `Daily/YYYY-MM-DD.md`                  |
| `move_note`       | Rename / move (refuses to overwrite an existing target)   |

## Setup

### 1. Build

Requires Node.js 24+ and pnpm (same as the web app).

```sh
cd mcp-server
pnpm install
pnpm build
```

This produces `dist/index.js` — the executable you'll point Claude Desktop at.

### 2. Configure Claude Desktop

Open `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)
or the equivalent on your OS. Add the `notes` server under `mcpServers`:

```json
{
  "mcpServers": {
    "notes": {
      "command": "node",
      "args": [
        "/ABSOLUTE/PATH/TO/notes-app/mcp-server/dist/index.js"
      ],
      "env": {
        "NOTES_ROOT": "/ABSOLUTE/PATH/TO/notes-app/notes"
      }
    }
  }
}
```

Replace both absolute paths with the real ones on your machine. **Both** must
be absolute — Claude Desktop doesn't resolve relative paths.

### 3. Restart Claude Desktop

Quit and relaunch. In a chat, you should see the new tools available (the
hammer / tools icon will show them). Try: _„Liste meine Notizen"_ and Claude
will call `list_notes`.

## Smoke test from the terminal

You can verify the server works without Claude:

```sh
cd mcp-server
NOTES_ROOT=/ABSOLUTE/PATH/TO/notes-app/notes node dist/index.js
```

The process reads MCP JSON-RPC on stdin and writes responses on stdout. To
test programmatically:

```sh
printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | NOTES_ROOT=/ABSOLUTE/PATH/TO/notes-app/notes node dist/index.js
```

You should see a tools list in the JSON output.

## Architecture

- **No separate database.** The server reads/writes plain Markdown files
  directly. Same as the web app — both are just two views over the same
  on-disk vault.
- **Frontmatter-aware.** YAML frontmatter (`created`, `modified`, `pinned`,
  custom keys) is parsed on read and auto-stamped on write.
- **Path safety.** Every relative path is resolved against `NOTES_ROOT` and
  refused if it escapes the root (no `../` shenanigans).
- **No file watching.** Tools always read fresh from disk, so concurrent edits
  from the web app are visible without any restart.

## Development

```sh
pnpm dev   # run from source via tsx (no compile step)
pnpm build # compile to dist/
```

The shared logic with the web app (`frontmatter.ts`, conventions) is
duplicated here on purpose — there's no monorepo overhead and the surface is
small enough that drift hasn't been a problem.
