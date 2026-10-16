# ROOTKey MCP server

Operate [ROOTKey](https://rootkey.ai) from Claude. This is the official [Model Context Protocol](https://modelcontextprotocol.io) server for the ROOTKey platform: it turns the whole documented ROOTKey REST API into tools Claude can call, so you can create vaults, anchor and validate files, write records, read audit trails and manage recovery points by asking for them in plain language.

It is a thin translation layer. Every tool call is a real API request made with your own personal access token, and everything it does shows up in the ROOTKey dashboard.

## Requirements

- Node.js 20 or newer
- A ROOTKey **personal access token**, created in the dashboard under your user **Settings -> Personal access tokens**. It looks like `rk_pat_` followed by 64 hexadecimal characters, it is shown once when you create it, and it lasts at most 90 days.

Organization API keys (**Developer Tools -> API Keys**) still work in 0.2.x through `ROOTKEY_API_KEY`, but they are deprecated and are removed in 0.3.0. See [Migrating from an organization API key](#migrating-from-an-organization-api-key).

## Install

### Let your agent do it

Hand any coding agent the published setup instructions and it configures itself, whichever client it runs in:

```
https://docs.rootkey.ai/agent-setup/prompt.md
```

### Claude Code

```bash
# ROOTKEY_TOKEN is already exported from your shell profile or secret manager, so the token never appears on the command line
claude mcp add rootkey --env ROOTKEY_TOKEN=$ROOTKEY_TOKEN -- npx -y @rootkey/mcp
```

### Claude Desktop

Claude Desktop keeps the token in plain text in its configuration file, so treat that file like a password. Add this to `claude_desktop_config.json` (Settings -> Developer -> Edit Config):

```json
{
  "mcpServers": {
    "rootkey": {
      "command": "npx",
      "args": ["-y", "@rootkey/mcp"],
      "env": { "ROOTKEY_TOKEN": "your_personal_access_token" }
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
      "env": { "ROOTKEY_TOKEN": "your_personal_access_token" }
    }
  }
}
```

### Shared with a team

Commit a `.mcp.json` at the root of your repository and let each person supply their own token (a personal access token belongs to one person, so never share one):

```json
{
  "mcpServers": {
    "rootkey": {
      "command": "npx",
      "args": ["-y", "@rootkey/mcp"],
      "env": { "ROOTKEY_TOKEN": "${ROOTKEY_TOKEN}" }
    }
  }
}
```

## Configuration

| Variable | Default | What it does |
| --- | --- | --- |
| `ROOTKEY_TOKEN` | required | Your personal access token (`rk_pat_` + 64 hex characters), sent as a Bearer token. The server exits immediately if it is missing or malformed, and never prints it. |
| `ROOTKEY_ORGANIZATION` | - | Default organization id for a personal access token. Every organization-scoped tool also takes an optional `organization` argument that overrides it for that call. If neither is set the tool asks which organization to use instead of guessing. Ignored (with a warning) with an organization API key, whatever its value. |
| `ROOTKEY_TEST_MODE` | unset (live) | `true` or `false`: which data set a personal access token works on, sent as `x-test-mode`. Test and live data are separate. Ignored (with a warning) with an organization API key. |
| `ROOTKEY_API_KEY` | - | **Deprecated, removed in 0.3.0.** An organization API key, accepted in place of `ROOTKEY_TOKEN` (never together with it: that is a configuration error). It prints a one-line warning on stderr and is bound to its one organization, so it is not offered `rootkey_list_organizations` or the `organization` argument. |
| `ROOTKEY_ENV` | `production` | Optional, and `production` is the only accepted value. ROOTKey has one public API, `https://api.rootkey.ai/api-v1/`; see below. |
| `ROOTKEY_API_URL` | - | Full base URL, including the `/api-v1/` path. Use it for a self-hosted or on-prem deployment. Plain `http://` is accepted only for loopback hosts. |
| `ROOTKEY_READ_ONLY` | `false` | When true, only the read tools are registered (14 with a personal access token, 17 with an organization API key), and downloads may only write inside `ROOTKEY_DOWNLOAD_DIR`. |
| `ROOTKEY_TIMEOUT_MS` | `30000` | Timeout for ordinary requests. |
| `ROOTKEY_TRANSFER_TIMEOUT_MS` | `300000` | Timeout for uploads and downloads. |
| `ROOTKEY_DOWNLOAD_DIR` | `~/Downloads` | Where downloads land when no path is given. |
| `ROOTKEY_ALLOWED_DIRS` | home, temp, cwd | Directories uploads may read from, separated by `;` on Windows and `:` elsewhere. |
| `ROOTKEY_LOG_LEVEL` | `info` | `silent`, `error`, `warn`, `info` or `debug`. Logs go to stderr. |

There is one public API, `https://api.rootkey.ai/api-v1/`, and no separate development environment. Whether you work on test or live data is a property of the credential, not of a host, and the two data sets are separate. A personal access token follows `ROOTKEY_TEST_MODE` (live when it is unset); an organization API key follows the key itself, a test key operating on your organization's test data and a live key on its live data. If you want to try things out, set `ROOTKEY_TEST_MODE=true` (or use a test key). The `development` value of `ROOTKEY_ENV` that 0.1.0 accepted pointed at a host that does not exist, so it is now obsolete: the server refuses to start with it and explains why, unless `ROOTKEY_API_URL` is set, in which case the URL is used as before and a warning goes to stderr. Remove the variable. For a self-hosted or on-prem deployment, point `ROOTKEY_API_URL` at it.

## Personal access tokens

A personal access token is *your* credential, not an organization's. It acts as you, in the organizations you chose when you created it, and never with more than you can do in the dashboard.

- **Create one** under your user **Settings -> Personal access tokens**: give it a name, pick the scopes (`rootkey.read`, `rootkey.write`, `rootkey.delete`), choose which organizations it covers (or all of yours), and set an expiry of up to 90 days. Revoke it there at any time; it stops working on the next request.
- **Every organization decides for itself.** An admin sets the organization's agent policy under **Settings -> AI agents**: `DISABLED` (agents are refused), `READ_ONLY` (the default when nothing is set) or `FULL`, and can block individual members, require two-factor authentication or refuse personal access tokens altogether. Your role, your teams and the organization's IP and country rules still apply on top.
- **RESTRICTED vaults are never reachable by an agent**, whatever the policy. They show up in `rootkey_list_vaults` and `rootkey_list_tables` with `agentAccessible: false` so you can see they exist, and nothing else.
- **A few operations are not available to agents at all**: recovery points, audit reports, the trash and restore. The API refuses them to every personal access token, so this server does not register the recovery point tools, `rootkey_generate_file_audit_report` or the `backup_workspace` prompt when you use a token (they stay available with an organization API key). Use the dashboard for those.
- **Keep the token narrow.** The `organization` argument can name any organization the token covers, and a prompt-injected model can use that. Create the token with the explicit list of organizations you need rather than "all of mine", and with only the scopes you need.
- **Results are data.** Organization, vault and file names, record contents and error text come from other people. The server tells the model so, strips control characters from listed names and flags them in the listing result, but the model is the last line of defence: do not paste untrusted documents into a session that holds a write-capable token.
- **What it does not do:** the organization governs the credentials it delegated, not "the AI". An agent driving your browser session, or a script holding an organization API key, is not distinguishable from you, and nothing here claims otherwise.
- **Every refusal is a tool error, not a crash.** The error names the cause and what has to change (for example "an organization admin must change it under Settings -> AI agents"), and never contains a credential.

### Choosing the organization

A token can reach several organizations, so the server never guesses. Set `ROOTKEY_ORGANIZATION` for a default, pass `organization` on a call to override it, or let the model call `rootkey_list_organizations` and ask you. The list shows each organization's agent policy mode and whether you are blocked in it, including the ones that currently refuse agents, so you can see why.

### Migrating from an organization API key

1. Create a personal access token with the scopes you need, covering the organization(s) the key belonged to.
2. Replace `ROOTKEY_API_KEY` with `ROOTKEY_TOKEN` in your client configuration, and set `ROOTKEY_ORGANIZATION` to the organization id (`rootkey_list_organizations` shows it). If the key was a test key, add `ROOTKEY_TEST_MODE=true`.
3. Expect the organization's agent policy to apply: with the default `READ_ONLY` policy the write tools are refused until an admin sets it to `FULL`.

Nothing changes if you stay on `ROOTKEY_API_KEY` for now: every 0.1.x configuration keeps working until 0.3.0, with one warning line at start-up.

## Tools

30 tools in all: every operation in the [public API](https://docs.rootkey.ai/api-reference/overview), the three listings that find what to operate on, a wait helper and one diagnostic. What you are offered depends on the credential, because a tool that can only fail is not worth advertising:

- **A personal access token gets 23.** The six recovery point tools and `rootkey_generate_file_audit_report` are left out (the API refuses them to agents), and every other tool takes the optional `organization` argument.
- **An organization API key gets 29.** Everything except `rootkey_list_organizations`, and none of the tools take an `organization` argument: the key is bound to one organization.

A change made with a personal access token says which organization it acted in ("Acted in organization ..."), so a wrong default cannot go unnoticed.

Every tool is prefixed `rootkey_`. Names like `list_files` or `download_file` collide head-on with the filesystem servers people commonly run alongside this one, and an agent that picks the wrong `download_file` fails silently rather than loudly.

**Organizations** - `rootkey_list_organizations` (personal access tokens only: the organizations you can act in, with each one's agent policy mode and whether you are blocked, cursor-paged)

**Vaults** - `rootkey_list_vaults`, `rootkey_create_vault`, `rootkey_update_vault`, `rootkey_delete_vault`

**Files** - `rootkey_list_files`, `rootkey_upload_file`, `rootkey_get_file`, `rootkey_download_file`, `rootkey_delete_file`, `rootkey_list_file_versions`, `rootkey_upload_file_version`, `rootkey_validate_file`, `rootkey_get_file_history`, `rootkey_get_file_validations`, `rootkey_generate_file_audit_report`

**Records** - `rootkey_list_tables`, `rootkey_list_records`, `rootkey_create_record`, `rootkey_list_record_versions`, `rootkey_get_record_history`, `rootkey_get_record_validations`, `rootkey_delete_record`

**Recovery points** (organization API key only) - `rootkey_list_recovery_points`, `rootkey_create_recovery_point`, `rootkey_get_recovery_point`, `rootkey_wait_for_recovery_point`, `rootkey_download_recovery_point`, `rootkey_delete_recovery_point`

**Diagnostics** - `rootkey_get_environment_info` (with a personal access token it asks the API who you are and what the token may do: user, token name, scopes and expiry, and for the selected organization its agent policy mode and the scopes that are effective there; with an organization API key it reports the configured environment and key mode and makes no API call. It never reveals the credential)

Every tool declares all four annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) according to what it does, so clients can gate them. Reads are read-only and idempotent; the four delete tools and `rootkey_update_vault` (which overwrites the previous name or description) are destructive. The two download tools sit in between: they change nothing in your ROOTKey workspace, so they run in read-only mode, but they do write a file to your disk, so they do not claim `readOnlyHint`.

The fifteen tools whose payload this server shapes -- every listing, both downloads, the wait helper and the diagnostic -- publish an `outputSchema` and return `structuredContent`, so a client can validate the result instead of parsing prose. The other fifteen hand back the API response untouched and deliberately declare no schema.

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

- **Vault and table addresses come from the list tools.** `rootkey_list_vaults` and `rootkey_list_tables` page through what you can see (a vault holds files, a table holds records), and `rootkey_create_vault` returns the address of what it creates. With a personal access token you see the vaults of the teams you belong to.
- **Uploads and downloads use local disk.** Files are read from, and written to, the machine running the server. Download tools return the saved path plus a `resource_link` the client can open, rather than inlining file contents into the conversation. An existing file is never overwritten.
- **Uploads can only read from a few directories.** `rootkey_upload_file`, `rootkey_upload_file_version` and `rootkey_validate_file` read a path off your disk and send it to the API, so they are confined to your home directory, the temp directory and wherever the server was started -- and they refuse hidden directories inside those, because `~/.ssh` and `~/.aws` hold credentials far more often than they hold documents anyone meant to anchor. Symlinks are resolved before the check, so a link cannot walk out. Widen or narrow it with `ROOTKEY_ALLOWED_DIRS`. This matters because the path can come from the model, and the model reads documents that other people wrote.
- **Deleting a vault, file or record moves it to the trash**, not off the planet. It vanishes from every list tool at once and stays recoverable from the Restore Center in the dashboard until the retention policy purges it. Deleting a *recovery point* is the exception: that one erases the archive for good. All four are annotated as destructive so Claude asks first.
- **Only files are anchored on chain.** Records are stored, hashed and audited, and come back `REGISTERED` immediately -- there is no pending phase and no transaction hash. The tool descriptions say so, because "your data is on a blockchain" is a compliance claim and it is only true of files.
- **Records are versioned by primary key.** Creating a record whose key matches an existing one adds a version rather than a duplicate, so retrying a create is not a no-op.
- **The recovery point password is shown once, and it lands in your chat.** `rootkey_create_recovery_point` surfaces it prominently and keeps it out of this server's logs -- but the only way to deliver it is to put it in the tool result, so it becomes part of the conversation and goes wherever that conversation is stored. Without it the archive cannot be decrypted: put it in a password manager, then consider clearing the chat.
- **Audit reports are queued, not returned.** The API accepts the job and delivers the finished report in the dashboard; there is no endpoint to fetch it.
- **Read-only mode hides `rootkey_validate_file`** even though the API classifies a validation as a read, because every call is recorded in the validation history and consumes plan quota.
- **Read-only mode is a convenience rail, not a security boundary.** Whatever this server registers, the credential decides what is possible: a personal access token carries the scopes you gave it, narrowed by each organization's agent policy; an organization API key (deprecated) has no scopes and carries the full privileges of its organization. What the mode *does* guarantee is local: no tool it registers changes your workspace, and the two that write to disk are pinned to the download directory.

## Development

```bash
npm install
npm run typecheck
npm test
```

`npm test` builds first, because `test/e2e.stdio.test.ts` spawns `dist/index.js` and would otherwise happily pass against a stale bundle. That file talks to the bundle over stdio against a local stub of the API, so it needs no network and no credential.

`test/contract.test.ts` drives every tool against a stubbed transport and checks what it puts on the wire against `test/fixtures/openapi-v2.json` -- method, path, and every parameter the spec marks required. That fixture is a copy of `api-reference/openapi-v2.json` from the docs repository; refresh it when the public API changes, and read the diff rather than working around it. The delegated-access operations (`GET /organizations`, `/vaults`, `/tables`, `/me`, `/organization`) are not in the public spec yet, so the same file pins them separately and fails the day the fixture documents them.

Inspect the built server with the MCP Inspector (it does not inherit your shell environment, so pass the key with `-e`):

```bash
npx @modelcontextprotocol/inspector --cli node dist/index.js -e ROOTKEY_TOKEN=$ROOTKEY_TOKEN --method tools/list
```

There is also a live round trip that creates a vault, exercises files and records, and deletes everything it made. It writes real data, so it is opt-in:

```bash
ROOTKEY_SMOKE=1 ROOTKEY_TOKEN=your_personal_access_token ROOTKEY_ORGANIZATION=your_org_id ROOTKEY_TEST_MODE=true npm run smoke
```

With a personal access token it refuses to run unless `ROOTKEY_ORGANIZATION` is set and `ROOTKEY_TEST_MODE=true` (or you acknowledge live data with `ROOTKEY_SMOKE_ALLOW_LIVE=1`). With a deprecated organization API key (`ROOTKEY_API_KEY`) the script cannot tell a test key from a live one unless the key starts with `rk_test_`; for any other key it refuses to run until you confirm it is a test key by also setting `ROOTKEY_SMOKE_ALLOW_LIVE=1`.

## Support

Full documentation: [docs.rootkey.ai](https://docs.rootkey.ai/pages/integrations/claude-mcp). Questions and bug reports: [support@rootkey.ai](mailto:support@rootkey.ai) or the [issue tracker](https://github.com/ROOT-Key/rootkey-mcp/issues).

## License

MIT
