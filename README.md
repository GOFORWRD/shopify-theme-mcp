# shopify-theme-mcp

Local MCP server that lets Claude Desktop read and edit your Shopify theme.
Wraps the Shopify CLI + a local theme directory, with automatic git commits on
every change and hard guardrails around the live theme.

## How it works

```
Claude Desktop ──stdio──> shopify-theme-mcp ──> local theme dir (git repo)
                                            └─> shopify CLI ──> Shopify Admin
```

- **Reads/edits happen locally** in `THEME_DIR` — fast, token-cheap, fully versioned.
- **`theme_pull` / `theme_push`** sync with Shopify via the CLI.
- **Every mutation auto-commits to git** with a `[claude]` prefix, so `git_history`
  + `git_revert_file` give you instant undo.
- **Live-theme protection:** `theme_push` refuses to target the published theme
  unless `allow_live: true` is explicitly passed, and `publish_theme` requires a
  `confirm: true` flag. The default flow is: edit → push unpublished copy →
  preview URL → you publish.

## Prerequisites

1. **Node 18+** — `node --version`
2. **Shopify CLI** — `npm install -g @shopify/cli@latest`, verify with `shopify version`
3. **Git** — already on macOS
4. **Auth (pick one):**
   - *Theme Access token (recommended for unattended use):* install the
     [Theme Access](https://apps.shopify.com/theme-access) app in your store
     admin, generate a password, and set it as `SHOPIFY_CLI_THEME_TOKEN` in the
     config below. No browser prompts, scoped to themes only.
   - *Interactive login:* run `shopify theme list --store my-store` once
     in a terminal and complete the browser login; the CLI caches the session.

## Install

```bash
cd ~/projects   # or wherever
git clone https://github.com/GOFORWRD/shopify-theme-mcp.git
cd shopify-theme-mcp
npm install
npm run build
mkdir -p ~/projects/my-theme   # local theme directory
```

## Claude Desktop config

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "shopify-theme": {
      "command": "node",
      "args": ["/Users/you/projects/shopify-theme-mcp/dist/index.js"],
      "env": {
        "SHOPIFY_STORE": "my-store",
        "THEME_DIR": "/Users/you/projects/my-theme",
        "SHOPIFY_CLI_THEME_TOKEN": "shptka_xxxxxxxxxxxx",
        "PATH": "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
      }
    }
  }
}
```

Notes:
- Adjust the two absolute paths for your machine.
- The explicit `PATH` matters — Claude Desktop launches servers with a minimal
  environment, and the server needs to find `shopify` and `git`. Check where
  yours lives with `which shopify` and include that directory.
- Omit `SHOPIFY_CLI_THEME_TOKEN` if you used interactive login.
- Restart Claude Desktop after saving.

## Tools

| Tool | What it does |
|---|---|
| `list_themes` | List themes with IDs and roles (live/unpublished/dev) |
| `theme_pull` | Download a theme (default: live) into `THEME_DIR`, git snapshot |
| `list_files` | List local theme files, optional filter |
| `read_file` | Read a file with line numbers, optional line range |
| `search_files` | Grep all theme files for text/regex |
| `write_file` | Create/overwrite a file → auto git commit |
| `patch_file` | Exact find-and-replace edit → auto git commit |
| `delete_file` | Delete local file → auto git commit |
| `theme_push` | Upload to Shopify — defaults to a new **unpublished** theme; live push gated behind `allow_live` |
| `publish_theme` | Make a theme live — gated behind `confirm` |
| `git_history` | Show recent commits |
| `git_revert_file` | Restore a file to a previous commit |

## Typical session

> **You:** "Update the Father's Day countdown in the announcement bar to say 'Last day for guaranteed delivery'"
>
> Claude: pulls live theme → searches for the countdown snippet → patches it →
> pushes to an unpublished copy → gives you the preview URL → you say "publish"
> → Claude publishes.

## Remote mode (VPS or Mac Mini behind a Cloudflare Tunnel)

The same server runs as a remote MCP endpoint — usable from Claude Desktop,
claude.ai, and mobile. Set `MCP_TRANSPORT=http` and it serves Streamable HTTP
on localhost, protected by an unguessable secret path segment:

```bash
export SHOPIFY_STORE=my-store
export THEME_DIR=/opt/my-theme
export SHOPIFY_CLI_THEME_TOKEN=shptka_xxxx
export MCP_TRANSPORT=http
export PORT=8787
export MCP_SECRET=$(openssl rand -hex 24)   # save this!
node dist/index.js
# -> Listening on 127.0.0.1:8787, endpoint: /<secret>/mcp
```

Endpoints: `POST /<MCP_SECRET>/mcp` (MCP), `GET /healthz` (monitoring).
The server binds to **127.0.0.1 only** — it is never directly exposed; the
tunnel is the only way in.

### VPS setup (Ubuntu/Debian)

```bash
# 1. deps
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt install -y nodejs git
sudo npm install -g @shopify/cli@latest

# 2. app
sudo mkdir -p /opt/shopify-theme-mcp /opt/my-theme
# clone the project into /opt/shopify-theme-mcp, then:
cd /opt/shopify-theme-mcp && npm install && npm run build

# 3. systemd service: /etc/systemd/system/shopify-theme-mcp.service
```

```ini
[Unit]
Description=Shopify Theme MCP
After=network.target

[Service]
WorkingDirectory=/opt/shopify-theme-mcp
ExecStart=/usr/bin/node dist/index.js
Restart=always
Environment=SHOPIFY_STORE=my-store
Environment=THEME_DIR=/opt/my-theme
Environment=SHOPIFY_CLI_THEME_TOKEN=shptka_xxxx
Environment=MCP_TRANSPORT=http
Environment=PORT=8787
Environment=MCP_SECRET=<openssl rand -hex 24>

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now shopify-theme-mcp
curl http://127.0.0.1:8787/healthz   # -> ok
```

```bash
# 4. cloudflared — add to your existing tunnel config ingress rules:
#   - hostname: shopify-theme.example.com
#     service: http://localhost:8787
# then add the DNS route:
cloudflared tunnel route dns <tunnel-name> shopify-theme.example.com
sudo systemctl restart cloudflared
```

### Mac Mini setup

Same idea: `npm install && npm run build`, run via `launchd` (or `pm2`), and
add an ingress hostname to the Mac Mini's existing tunnel config
(`~/.cloudflared/config.yml`) pointing at `http://localhost:8787`, e.g.
`theme.example.com`.

### Connecting Claude

- **claude.ai / Claude Desktop / mobile:** Settings → Connectors → Add custom
  connector → URL: `https://shopify-theme.example.com/<MCP_SECRET>/mcp`
- **Claude Desktop local (stdio):** still works — just omit `MCP_TRANSPORT`.

### Remote-mode notes

- Run `shopify theme pull` once on the host (or call the `theme_pull` tool) to
  seed the theme directory.
- The secret in the URL is the only auth — treat the full URL like a password.
  Rotate by changing `MCP_SECRET` and updating the connector.
- HTTP mode is stateless per request, but all file/git/CLI operations are
  serialized through a global mutex, so concurrent sessions can't corrupt the
  repo.


## Known limitations

- `theme_push` does **not** delete remote files that were deleted locally
  (the server pushes with default CLI behavior). Delete via the Shopify admin
  or run `shopify theme push --json` manually without `--nodelete` semantics if needed.
- Binary assets (images/fonts) are pulled/pushed but not readable/editable via
  `read_file`/`patch_file`.
- If two people edit the theme simultaneously (admin editor + this server),
  re-run `theme_pull` before editing to avoid clobbering changes.

## Security

- `SHOPIFY_CLI_THEME_TOKEN` (a Theme Access password, `shptka_…`) and `MCP_SECRET`
  are credentials. Keep them in your Claude Desktop config or systemd unit — never
  commit them. `.gitignore` covers `.env`, but the systemd unit lives outside the
  repo by design.
- In remote mode the secret path **is** the credential: anyone with the full URL can
  read and write your theme. URLs leak more readily than headers (shell history,
  proxy logs, config files), so rotate `MCP_SECRET` if it is ever exposed.
- The server binds to `127.0.0.1` only; the tunnel is the sole public route.
- Scope the Theme Access token to themes only — it cannot touch orders or customers.

## Licence

MIT — see [LICENSE](LICENSE).
