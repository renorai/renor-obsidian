# Renor for Obsidian

Your vault becomes memory your AI agents can use. Choose the folders to share, and Claude, ChatGPT, Codex, Cursor and
your own agents can recall them through Renor. What those agents save shows up back in your vault as notes.

- **Nothing is shared until you choose a folder.** Private folders, the `Renor/` folder and Obsidian's settings are never shared.
- **Live sync.** Edits, renames and deletions reach Renor a couple of seconds after you stop typing. An edit replaces the old copy, so recall never sees two versions of one note.
- **What agents saved** lands in `Renor/` as notes. This is a one-way copy: edit a memory from an agent or the Renor dashboard, not in the copy.
- **Ask Renor** (command palette): ask what your agents' memory holds and insert the answer into the current note.

**Network and account.** The plugin talks only to the Renor server in its settings (`https://mcp.renor.cloud/mcp` by
default), and only for three things: notes in folders you shared, your Ask Renor questions, and pulling what agents
saved. It needs a Renor account and API key. The plugin itself sends no telemetry.

## Install (unpacked, before a community-plugins listing)

```bash
cd integrations/obsidian-plugin
npm ci
npm run build                   # typecheck, then bundle to main.js
mkdir -p "<your vault>/.obsidian/plugins/renor"
cp main.js manifest.json "<your vault>/.obsidian/plugins/renor/"
```

In Obsidian: **Settings → Community plugins**, turn them on, and enable **Renor**. It needs Obsidian 1.11.4 or later,
which provides the secret storage that holds the key.

## Connect

1. In the Renor dashboard, create an API key.
2. **Settings → Renor → API key**: paste it. The key is kept in Obsidian's secret storage, never in the plugin's
   `data.json`, so syncing or committing your vault does not leak it.
3. Press **Check**, then **Add shared folder** (or right-click a folder → **Share with Renor**).

```text
Settings → Renor
  API key            •••••••• (saved)
  Server             https://mcp.renor.cloud/mcp
  Shared folders     Projects                      [x]
  Private folders    Projects/Private              [x]
  Renor folder       Renor
  Pull every         15 minutes
```

Commands: **Ask Renor**, **Sync shared folders now**, **Pull what agents saved into the Renor folder**.

## How it reaches Renor (no second importer)

The plugin uses Renor's existing import tools over MCP. It does not have an importer of its own.

| Vault event | Renor calls |
| --- | --- |
| note created / edited in a shared folder | `preview_import` (check), then `undo_import` of the note's previous batch if there is one, `preview_import` + `apply_import` |
| note deleted, moved out, or its folder unshared / marked private | `undo_import` of its batch (the copy is retired, recoverable from Renor's trash) |
| rename | removal of the old path, then sync of the new one |
| "Pull what agents saved" | `memory_map`, `read_memory` (memories whose origin is `import` are skipped, so nothing echoes) |
| Ask Renor | `get_context` |

Notes land in Renor under `Imported/obsidian-<vault name>/<path in vault>`. Each note is its own batch, so one edit
replaces one note. A note Renor will not take is listed under **Settings → Renor → Not synced**, and the copy already in
Renor is kept. That covers a note over 64 KiB (the per-note import limit) and a note in which Renor's secret guard finds
a password, key or token. The plugin keeps `path → {hash, batchId}` in `data.json`, so an unchanged note costs no
network call.

`renor sync` in the setup CLI (PR #786) is the command-line path to the same tools, with the same rule: one batch per
file, and `undo_import` of the old batch before a changed file is imported again. The two keep separate folders
(`Imported/synced/` for the CLI, `Imported/obsidian-<vault>/` here), so a vault synced by both would be held twice. Use one
per folder. The plugin also checks a changed note (`stage: false`) before it undoes the old copy, so a note Renor would
refuse never leaves Renor without a copy. The sync engine talks to a `SyncBackend` interface, so a later shared backend
can replace `ImportToolsBackend` without touching settings, folder rules or event wiring.

## For agents

Your coding agent can choose the shared and private folders by editing `renor.json` at the vault root. The plugin
creates it on first start, applies every save live, and writes your changes in Settings back to it. Edit only the two
lists; the file never holds the API key (that stays in Obsidian's secret storage) and a key put there is ignored.

```json
{
  "sharedFolders": ["Projects", "Notes/Work"],
  "privateFolders": ["Projects/Salary"]
}
```

`"/"` in `sharedFolders` shares the whole vault. Whatever the file says, a private folder, the `Renor/` folder,
`.obsidian` and any dot-folder are never shared, and a path with `..` is dropped. Entries the plugin refuses are named
in a notice. Obsidian shows a notice whenever the shared set changes from the file. If the file is not valid JSON,
the folders stay as they were. Removing a folder from `privateFolders` in the file does not make it shareable: it
stays private, with a notice, until you remove it in Settings.

## Self-hosted

If you run Renor yourself, you do not need this plugin to share notes. Point the engine at the vault:

```bash
export VAULT_PATH="/absolute/path/to/your vault"
node dist/cli.js index      # then register `node dist/cli.js mcp` with your agent
node dist/cli.js watch      # optional: re-index as you edit
```

The engine then reads the whole vault directly. [The self-hosting guide](https://github.com/renorai/renor-engine/blob/main/docs/self-hosting.md) has
the details. Notes the agents save land in the vault itself (`Memory/…`), so the `Renor/` folder is not needed either.
Leave Obsidian's own folders out of the vault you point at if you do not want them indexed.

The plugin's **Server** field can point at a self-hosted Renor HTTP server's `/mcp`, but that server signs in with
OAuth, and its tokens last an hour by default (`MVP_ACCESS_TOKEN_TTL_SECONDS`). The plugin has no OAuth flow yet, so
treat that as a test setup, not daily use.

**Server** must be an `https://` address. The only exception is plain `http://` to this computer (`127.0.0.1`,
`localhost` or `::1`). Any other address is refused before a request is made, so the key and your notes are never sent
unencrypted. Notes the plugin writes stay inside the Renor folder. A note already there is rewritten only when its
`renor_id` names the memory being pulled; any other note at that name is left alone, and the memory gets a new name.

## Develop

```bash
npm ci
npm run typecheck
npm test            # unit tests + integration tests against the offline engine
npm run build
```

The integration tests start the self-hosted engine (`engine/dist/mvp/cli.js`) offline, with no embedding model and no
model keys, in a temporary folder. They sign in as its owner over OAuth and drive the plugin through a mocked Obsidian
API (`test/obsidian-mock.ts`). Build the engine first (`cd engine && npm ci && npm run build`); without it those suites
are skipped and say so.

## License

MIT
