# ROOTKey MCP server

Operate [ROOTKey](https://rootkey.ai) from Claude. This is the official [Model Context Protocol](https://modelcontextprotocol.io) server for the ROOTKey platform: it turns the whole documented ROOTKey REST API into tools Claude can call, so you can create vaults, anchor and validate files, write records, read audit trails and manage recovery points by asking for them in plain language.

It is a thin translation layer. Every tool call is a real API request made with your own API key, and everything it does shows up in the ROOTKey dashboard.

## Requirements

- Node.js 20 or newer
- A ROOTKey API key, from the dashboard under **Developer Tools -> API Keys**

## Install

### Let your agent do it

Hand any coding agent the published setup instructions and it configures itself, whichever client it runs in:

```
https://docs.rootkey.ai/agent-setup/prompt.md
```

### Claude Code

```bash
claude mcp add rootkey --env ROOTKEY_API_KEY=your_api_key -- npx -y @rootkey/mcp
```

### Claude Desktop

Add this to `claude_desktop_config.json` (Settings -> Developer -> Edit Config):

```json
{
  "mcpServers": {
    "rootkey": {
      "command": "npx",
      "args": ["-y", "@rootkey/mcp"],
      "env": { "ROOTKEY_API_KEY": "your_api_key" }
    }
  }
}
```

On Windows, route the command through `cmd` so `npx` resolves:

```json
{
  "mcpServers": {
    "rootkey": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@rootkey/mcp"],
      "env": { "ROOTKEY_API_KEY": "your_api_key" }
    }
  }
}
```

### Shared with a team

Commit a `.mcp.json` at the root of your repository and let each person supply their own key:

```json
{
  "mcpServers": {
    "rootkey": {
      "command": "npx",
      "args": ["-y", "@rootkey/mcp"],
      "env": { "ROOTKEY_API_KEY": "${ROOTKEY_API_KEY}" }
    }
  }
}
```

## Configuration

| Variable | Default | What it does |
| --- | --- | --- |
| `ROOTKEY_API_KEY` | required | Your ROOTKey API key. The server exits immediately if it is missing. |
| `ROOTKEY_ENV` | `production` | Optional, and `production` is the only accepted value. ROOTKey has one public API, `https://api.rootkey.ai/api-v1/`; see below. |
| `ROOTKEY_API_URL` | - | Full base URL, including the `/api-v1/` path. Use it for a self-hosted or on-prem deployment. Plain `http://` is accepted only for loopback hosts. |
| `ROOTKEY_READ_ONLY` | `false` | When true, only the 15 read tools are registered, and downloads may only write inside `ROOTKEY_DOWNLOAD_DIR`. |
| `ROOTKEY_TIMEOUT_MS` | `30000` | Timeout for ordinary requests. |
| `ROOTKEY_TRANSFER_TIMEOUT_MS` | `300000` | Timeout for uploads and downloads. |
| `ROOTKEY_DOWNLOAD_DIR` | `~/Downloads` | Where downloads land when no path is given. |
| `ROOTKEY_ALLOWED_DIRS` | home, temp, cwd | Directories uploads may read from, separated by `;` on Windows and `:` elsewhere. |
| `ROOTKEY_LOG_LEVEL` | `info` | `silent`, `error`, `warn`, `info` or `debug`. Logs go to stderr. |

There is one public API, `https://api.rootkey.ai/api-v1/`, and no separate development environment. Whether you work on test or live data is a property of the API key, not of a host: a test key operates on your organization's test data, a live key on its live data, and the two data sets are separate. If you want to try things out, use a test key. The `development` value of `ROOTKEY_ENV` that 0.1.0 accepted pointed at a host that does not exist, so it is now obsolete: the server refuses to start with it and explains why, unless `ROOTKEY_API_URL` is set, in which case the URL is used as before and a warning goes to stderr. Remove the variable. For a self-hosted or on-prem deployment, point `ROOTKEY_API_URL` at it.

## Tools

27 tools: every operation in the [public API](https://docs.rootkey.ai/api-reference/overview), plus a wait helper and one local diagnostic.

Every tool is prefixed `rootkey_`. Names like `list_files` or `download_file` collide head-on with the filesystem servers people commonly run alongside this one, and an agent that picks the wrong `download_file` fails silently rather than loudly.

**Vaults** - `rootkey_create_vault`, `rootkey_update_vault`, `rootkey_delete_vault`

**Files** - `rootkey_list_files`, `rootkey_upload_file`, `rootkey_get_file`, `rootkey_download_file`, `rootkey_delete_file`, `rootkey_list_file_versions`, `rootkey_upload_file_version`, `rootkey_validate_file`, `rootkey_get_file_history`, `rootkey_get_file_validations`, `rootkey_generate_file_audit_report`

**Records** - `rootkey_list_records`, `rootkey_create_record`, `rootkey_list_record_versions`, `rootkey_get_record_history`, `rootkey_get_record_validations`, `rootkey_delete_record`

**Recovery points** - `rootkey_list_recovery_points`, `rootkey_create_recovery_point`, `rootkey_get_recovery_point`, `rootkey_wait_for_recovery_point`, `rootkey_download_recovery_point`, `rootkey_delete_recovery_point`

**Diagnostics** - `rootkey_get_environment_info` (reports the configured environment, key type and tool count; makes no API call and never reveals the key)

Read tools carry `readOnlyHint` and the four delete tools carry `destructiveHint`, so clients can gate them. The two download tools sit in between: they change nothing in your ROOTKey workspace, so they run in read-only mode, but they do write a file to your disk, so they do not claim `readOnlyHint`.

The twelve tools whose payload this server shapes -- every listing, both downloads, the wait helper and the diagnostic -- publish an `outputSchema` and return `structuredContent`, so a client can validate the result instead of parsing prose. The other fifteen hand back the API response untouched and deliberately declare no schema.

## Prompts

Four workflows, offered as MCP prompts so your client can list them instead of you having to remember the sequence:

| Prompt | What it does |
| --- | --- |
| `anchor_folder` | Anchors every file in a local folder into a vault, confirming first and reporting what landed. |
| `compliance_evidence_pack` | Gathers the anchor, activity history, validations and version chain for one file, and writes it up -- including what the evidence does *not* prove. |
| `verify_local_copies` | Validates local files against their anchors and leads with the failures. |
| `backup_workspace` | Creates a recovery point, waits for it, downloads it, and handles the one-time password carefully. |

In read-only mode only `compliance_evidence_pack` is offered, since the other three write.

## Things worth knowing

- **Vault addresses come from the dashboard.** The ROOTKey API has no endpoint that lists vaults, so this server cannot offer one. `rootkey_create_vault` returns the address of what it creates; keep it.
- **Uploads and downloads use local disk.** Files are read from, and written to, the machine running the server. Download tools return the saved path plus a `resource_link` the client can open, rather than inlining file contents into the conversation. An existing file is never overwritten.
- **Uploads can only read from a few directories.** `rootkey_upload_file`, `rootkey_upload_file_version` and `rootkey_validate_file` read a path off your disk and send it to the API, so they are confined to your home directory, the temp directory and wherever the server was started -- and they refuse hidden directories inside those, because `~/.ssh` and `~/.aws` hold credentials far more often than they hold documents anyone meant to anchor. Symlinks are resolved before the check, so a link cannot walk out. Widen or narrow it with `ROOTKEY_ALLOWED_DIRS`. This matters because the path can come from the model, and the model reads documents that other people wrote.
- **Deleting a vault, file or record moves it to the trash**, not off the planet. It vanishes from every list tool at once and stays recoverable from the Restore Center in the dashboard until the retention policy purges it. Deleting a *recovery point* is the exception: that one erases the archive for good. All four are annotated as destructive so Claude asks first.
- **Only files are anchored on chain.** Records are stored, hashed and audited, and come back `REGISTERED` immediately -- there is no pending phase and no transaction hash. The tool descriptions say so, because "your data is on a blockchain" is a compliance claim and it is only true of files.
- **Records are versioned by primary key.** Creating a record whose key matches an existing one adds a version rather than a duplicate, so retrying a create is not a no-op.
- **The recovery point password is shown once, and it lands in your chat.** `rootkey_create_recovery_point` surfaces it prominently and keeps it out of this server's logs -- but the only way to deliver it is to put it in the tool result, so it becomes part of the conversation and goes wherever that conversation is stored. Without it the archive cannot be decrypted: put it in a password manager, then consider clearing the chat.
- **Audit reports are queued, not returned.** The API accepts the job and delivers the finished report in the dashboard; there is no endpoint to fetch it.
- **Read-only mode is a convenience rail, not a security boundary.** ROOTKey API keys have no scopes and carry the full privileges of the account that owns them. Anything holding the key can do anything the account can, whatever this server registers. What the mode *does* guarantee is local: no tool it registers changes your workspace, and the two that write to disk are pinned to the download directory.

## Development

```bash
npm install
npm run typecheck
npm test
```

`npm test` builds first, because `test/e2e.stdio.test.ts` spawns `dist/index.js` and would otherwise happily pass against a stale bundle.

`test/contract.test.ts` drives every tool against a stubbed transport and checks what it puts on the wire against `test/fixtures/openapi-v2.json` -- method, path, and every parameter the spec marks required. That fixture is a copy of `api-reference/openapi-v2.json` from the docs repository; refresh it when the public API changes, and read the diff rather than working around it.

Inspect the built server with the MCP Inspector (it does not inherit your shell environment, so pass the key with `-e`):

```bash
npx @modelcontextprotocol/inspector --cli node dist/index.js -e ROOTKEY_API_KEY=your_test_api_key --method tools/list
```

There is also a live round trip that creates a vault, exercises files and records, and deletes everything it made. It writes real data, so it is opt-in:

```bash
ROOTKEY_SMOKE=1 ROOTKEY_API_KEY=your_test_api_key npm run smoke
```

The script cannot tell a test key from a live one unless the key starts with `rk_test_`; for any other key it refuses to run until you confirm it is a test key by also setting `ROOTKEY_SMOKE_ALLOW_LIVE=1`.

## Support

Full documentation: [docs.rootkey.ai](https://docs.rootkey.ai/pages/integrations/claude-mcp). Questions and bug reports: [support@rootkey.ai](mailto:support@rootkey.ai) or the [issue tracker](https://github.com/ROOT-Key/rootkey-mcp/issues).

## License

MIT
