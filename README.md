# ROOTKey MCP server

Operate [ROOTKey](https://rootkey.ai) from Claude. This is the official [Model Context Protocol](https://modelcontextprotocol.io) server for the ROOTKey platform: it turns the whole documented ROOTKey REST API into tools Claude can call, so you can create vaults, anchor and validate files, write records, read audit trails and manage recovery points by asking for them in plain language.

It is a thin translation layer. Every tool call is a real API request made with your own API key, and everything it does shows up in the ROOTKey dashboard.

## Requirements

- Node.js 20 or newer
- A ROOTKey API key, from the dashboard under **Platform -> Developer Tools -> API Keys**

## Install

### Claude Code

```bash
claude mcp add rootkey --env ROOTKEY_API_KEY=rk_live_your_key -- npx -y @rootkey/mcp
```

### Claude Desktop

Add this to `claude_desktop_config.json` (Settings -> Developer -> Edit Config):

```json
{
  "mcpServers": {
    "rootkey": {
      "command": "npx",
      "args": ["-y", "@rootkey/mcp"],
      "env": { "ROOTKEY_API_KEY": "rk_live_your_key" }
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
      "env": { "ROOTKEY_API_KEY": "rk_live_your_key" }
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
| `ROOTKEY_ENV` | `production` | `production` or `development`. Picks the matching API base URL. |
| `ROOTKEY_API_URL` | - | Full base URL, including the `/api-v1/` path. Overrides `ROOTKEY_ENV`. |
| `ROOTKEY_READ_ONLY` | `false` | When true, only the 14 read tools are registered. |
| `ROOTKEY_TIMEOUT_MS` | `30000` | Timeout for ordinary requests. |
| `ROOTKEY_TRANSFER_TIMEOUT_MS` | `300000` | Timeout for uploads and downloads. |
| `ROOTKEY_DOWNLOAD_DIR` | `~/Downloads` | Where downloads land when no path is given. |
| `ROOTKEY_LOG_LEVEL` | `info` | `silent`, `error`, `warn`, `info` or `debug`. Logs go to stderr. |

Use an `rk_test_` key with `ROOTKEY_ENV=development` while you are trying things out: the development environment anchors nothing on Polygon Mainnet and costs no credits.

## Tools

26 tools: every operation in the [public API](https://docs.rootkey.ai/api-reference/overview), plus one local diagnostic.

**Vaults** - `create_vault`, `update_vault`, `delete_vault`

**Files** - `list_files`, `upload_file`, `get_file`, `download_file`, `delete_file`, `list_file_versions`, `upload_file_version`, `validate_file`, `get_file_history`, `get_file_validations`, `generate_file_audit_report`

**Records** - `list_records`, `create_record`, `list_record_versions`, `get_record_history`, `get_record_validations`, `delete_record`

**Recovery points** - `list_recovery_points`, `create_recovery_point`, `get_recovery_point`, `download_recovery_point`, `delete_recovery_point`

**Diagnostics** - `get_environment_info` (reports the configured environment, key type and tool count; makes no API call and never reveals the key)

Read tools carry `readOnlyHint`, and the four delete tools carry `destructiveHint`, so clients can gate them.

## Things worth knowing

- **Vault addresses come from the dashboard.** The ROOTKey API has no endpoint that lists vaults, so this server cannot offer one. `create_vault` returns the address of what it creates; keep it.
- **Uploads and downloads use local disk.** Files are read from, and written to, the machine running the server, and download tools return a path rather than inlining file contents. An existing file is never overwritten.
- **Deletes are permanent** and recorded on chain. They are annotated as destructive so Claude asks first.
- **Records are versioned by primary key.** Creating a record whose key matches an existing one adds a version rather than a duplicate, so retrying a create is not a no-op.
- **The recovery point password is shown once.** `create_recovery_point` surfaces it prominently and it is never written to the logs; without it the archive cannot be decrypted.
- **Audit reports are queued, not returned.** The API accepts the job and delivers the finished report in the dashboard; there is no endpoint to fetch it.
- **Read-only mode is a convenience rail, not a security boundary.** ROOTKey API keys have no scopes and carry the full privileges of the account that owns them. Anything holding the key can do anything the account can, whatever this server registers.

## Development

```bash
npm install
npm run typecheck
npm run build
npm test
```

Inspect the built server with the MCP Inspector (it does not inherit your shell environment, so pass the key with `-e`):

```bash
npx @modelcontextprotocol/inspector --cli node dist/index.js -e ROOTKEY_API_KEY=rk_test_your_key --method tools/list
```

There is also a live round trip that creates a vault, exercises files and records, and deletes everything it made. It writes real data, so it is opt-in:

```bash
ROOTKEY_SMOKE=1 ROOTKEY_API_KEY=rk_test_your_key ROOTKEY_ENV=development npm run smoke
```

## Support

Full documentation: [docs.rootkey.ai](https://docs.rootkey.ai/pages/integrations/claude-mcp). Questions and bug reports: [support@rootkey.ai](mailto:support@rootkey.ai) or the [issue tracker](https://github.com/ROOT-Key/rootkey-mcp/issues).

## License

MIT
