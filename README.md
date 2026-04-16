# Anki BiSync

**Bidirectional synchronization** between Obsidian markdown files and Anki flashcards via [AnkiConnect](https://ankiweb.net/shared/info/2055492159).

---

## Requirements

- [Anki](https://apps.ankiweb.net/) desktop app
- [AnkiConnect](https://ankiweb.net/shared/info/2055492159) add-on installed in Anki
- Obsidian desktop app (plugin is desktop-only)

---

## Markdown File Format

Cards are defined by `## Heading` sections in your markdown files:

```markdown
---
aliases:
tags:
  - linux
  - test
created: 2025-07-10
parent: "[[MOC Linux]]"
cards: 2
lastAnkiSynced: 2025-07-12
---

## What is a process in Linux?
A process is an instance of a running program. Each process has a unique PID.
Processes can be in states: running, sleeping, stopped, zombie.

`next_review: 2025-07-16`
`reviewed: 5 times`

---
## How to list running processes?
Use `ps aux` to list all running processes.
Use `top` or `htop` for real-time monitoring.

`next_review: 2025-07-18`
`reviewed: 3 times`
```

### Parsing Rules

| Element | Mapped to |
|---------|-----------|
| `## Heading text` | Anki card **Front** (question) |
| Body until next `##` | Anki card **Back** (answer) |
| `` `next_review: YYYY-MM-DD` `` | Plugin-managed scheduling metadata |
| `` `reviewed: N times` `` | Plugin-managed review count |
| Frontmatter `parent: "[[MOC Linux]]"` | Anki deck name → `Linux` |
| Frontmatter `tags:` array | Applied as Anki tags |

- Horizontal rules (`---`) between sections are **visual separators only** — they do not delimit cards
- Content between the last `---` frontmatter delimiter and the first `##` is preserved but not synced as a card
- Per-card metadata lines are **stripped** from the Anki Back field — they're only displayed in Obsidian

---

## Anki Note Model

The plugin automatically creates a custom Anki note type called **`ObsidianBiSync`** with these fields:

| Field | Content |
|-------|---------|
| `Front` | Question (heading text) |
| `Back` | Answer (body text) |
| `Source` | `VaultName::path/to/file.md` |
| `ObsidianPath` | Vault-relative file path |
| `CardID` | `filename-slug::heading-slug` |

---

## Deck Mapping

Deck name is derived from the frontmatter `parent:` field:

| Frontmatter | Deck |
|-------------|------|
| `parent: "[[MOC Linux]]"` | `Linux` |
| `parent: "[[MOC JavaScript]]"` | `JavaScript` |
| No `parent:` field | Default deck (configurable, default: `Obsidian`) |

---

## Commands

| Command | Default Hotkey | Description |
|---------|---------------|-------------|
| Anki BiSync: Sync current file | `Ctrl+Shift+A` | Sync the active file to Anki |
| Anki BiSync: Sync entire vault | — | Sync all files in configured folders |
| Anki BiSync: Pull from Anki | — | Pull Anki changes back to MD files |
| Anki BiSync: Test AnkiConnect | — | Verify AnkiConnect is reachable |

The ribbon icon (🔄) triggers **Sync entire vault**.

---

## Settings

### Connection
- **AnkiConnect URL** — default `http://127.0.0.1:8765`
- **API Key** — optional, if you've set one in AnkiConnect settings
- **Test Connection** — checks reachability and shows version

### Sync Folders
- **Folders to sync** — one path per line; `/` = entire vault
- **Folders to exclude** — always excluded from sync

### Behavior
- **Sync on save** — sync the current file when you save (500ms debounce)
- **Bi-directional sync** — pull Anki edits and review data back to MD
- **On heading deletion** — delete or suspend the Anki card
- **Auto-sync interval** — sync vault every N minutes (0 = disabled)

---

## How Sync Works

### Push (Obsidian → Anki)

1. Parse all `## Heading` sections in the file
2. For each heading: generate a `CardID = {filename-slug}::{heading-slug}`
3. Query Anki for an existing card with that `CardID`
4. If found → update fields if changed; if not found → create card
5. Find orphaned Anki cards (heading removed from MD) → delete or suspend
6. Update frontmatter: `cards:` count and `lastAnkiSynced:` date

### Pull (Anki → Obsidian)

1. Find all Anki notes tagged with the file's filename tag
2. Compare Anki field values with local MD content
3. If Anki was modified more recently → update heading/body in MD
4. Update `next_review:` and `reviewed:` metadata from Anki scheduling data
5. Update frontmatter `next_review:` with the earliest card review date

### Conflict Resolution

When both Obsidian and Anki have changes since the last sync:
- Whichever was modified **most recently** wins
- Conflicts are logged to the developer console

---

## ⚠ Known Limitations

### Heading Rename = Lost Review History

When you rename a `## Heading`, the `CardID` changes (it's derived from the heading text). The old Anki card will be treated as deleted (and deleted/suspended per your setting), and a **new card** will be created — **losing all review history** for the old heading.

**Workaround:** Don't rename headings once you've started reviewing them. If you must rename, note the early review will reset in Anki.

### `due` Date Approximation

Anki stores review card `due` dates as an offset from the collection creation date, which AnkiConnect doesn't expose directly. The plugin uses a best-effort calculation based on the card's `interval` and last modification time. The `next_review` date in your MD file is approximate (±1 day).

---

## Development

```bash
# Install dependencies
npm install

# Development (watch mode)
npm run dev

# Production build
npm run build
```

The output `main.js` is placed in the plugin folder root, ready for Obsidian to load.

---

## License

MIT
