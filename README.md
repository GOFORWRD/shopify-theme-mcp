# shopify-theme-mcp

An [MCP](https://modelcontextprotocol.io/) server that lets Claude read and edit your Shopify theme.
It wraps the Shopify CLI and a local theme directory, auto-commits every change to git, and refuses to
touch your live theme unless you explicitly say so.

Runs as a local stdio server for Claude Desktop, or as a remote HTTP endpoint you can reach from
claude.ai and mobile.

## How it works

```
Claude ──stdio──> shopify-theme-mcp ──> local theme dir (git repo)
                                    └─> shopify CLI ──> Shopify Admin
```

- **Edits happen locally** in `THEME_DIR` — fast, token-cheap, fully versioned.
- **Every mutation auto-commits** with a `[claude]` prefix, so `git_history` + `git_revert_file`
  give you instant undo. The server runs `git init` itself if `THEME_DIR` isn't already a repo.
- **`theme_pull` / `theme_push`** sync with Shopify through the CLI.
- **Live-theme protection:** `theme_push` defaults to creating a *new unpublished* theme. Pushing to
  the published theme requires `allow_live: true`; `publish_theme` requires `confirm: true`.
- **Hidden content is skipped by default** — see [Hidden and disabled content](#hidden-and-disabled-content).

## Contents

- [Requirements](#requirements)
- [Installing the Shopify CLI](#installing-the-shopify-cli)
- [Getting a Theme Access token](#getting-a-theme-access-token)
- [Install](#install)
- [Claude Desktop (local, stdio)](#claude-desktop-local-stdio)
- [Tools](#tools)
- [Hidden and disabled content](#hidden-and-disabled-content)
- [Remote mode (HTTP)](#remote-mode-http)
- [Configuration reference](#configuration-reference)
- [Typical session](#typical-session)
- [Security](#security)
- [Known limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)

---

## Requirements

| | |
|---|---|
| **Node.js** | **22.12 or newer** — required by the Shopify CLI (`node --version`) |
| **Shopify CLI** | See [Installing the Shopify CLI](#installing-the-shopify-cli) |
| **Git** | Preinstalled on macOS; `sudo apt install git` on Debian/Ubuntu |
| **Shopify auth** | A Theme Access password, or an interactive CLI login |

> **On the Node version.** This package's own `engines` field says Node 18+, which is true of the
> server itself, but the Shopify CLI it shells out to requires **22.12+**. Install 22.12 or newer or
> theme commands will fail. [nvm](https://github.com/nvm-sh/nvm) is the easiest way to manage this:
> `nvm install 22 && nvm use 22`.

---

## Installing the Shopify CLI

The CLI does the actual talking to Shopify — this server wraps it. Theme commands are built into
`@shopify/cli`; there is no separate theme package to install any more.

**npm** (any platform):

```bash
npm install -g @shopify/cli@latest
```

**Homebrew** (macOS):

```bash
brew tap shopify/shopify
brew install shopify-cli
```

<details>
<summary>yarn / pnpm</summary>

```bash
yarn global add @shopify/cli@latest
# or
pnpm install -g @shopify/cli@latest
```

</details>

Verify the install — this must work before the MCP server will:

```bash
shopify version
which shopify     # note this path; you may need it for Claude Desktop's PATH
```

If `shopify` isn't found, your global npm bin directory isn't on your `PATH`. Find it with
`npm bin -g` and add it to your shell profile.

> The CLI self-upgrades from v4.0 onward. If that is a problem on a server you manage,
> disable it with `shopify config autoupgrade off`.

---

## Getting a Theme Access token

This is the recommended way to authenticate, and the **only** option for headless or remote use.
The token is scoped to themes only — it cannot read orders or customer data.

### 1. Check you have permission

- **Store owner** — access is automatic.
- **Staff** — you need *Edit permissions* (including *Add and remove staff*) plus *Themes*
  permissions.
- **Collaborators** — you need *Themes* permissions under online store settings.

If you don't have these, ask the store owner to generate the password and send it to you.

### 2. Install the Theme Access app

Go to the [Theme Access app](https://apps.shopify.com/theme-access) on the Shopify App Store, click
**Add app**, then **Install app** in your admin to authorise it.

### 3. Create a password

In the Theme Access app, click **Create theme password**, enter the developer's name and email
address, and submit. Shopify emails that address a link to the password.

> ### ⚠️ You can only view the password once
>
> The emailed link **expires after 7 days, or immediately once the password has been viewed** —
> whichever comes first. Copy it straight into your Claude Desktop config, systemd unit or password
> manager the moment you open it. If you lose it, you cannot recover it; delete the entry and create
> a new one.

Theme Access passwords typically begin `shptka_`.

### 4. Use it

Set it as `SHOPIFY_CLI_THEME_TOKEN` wherever you configure the server (Claude Desktop `env` block,
or the systemd unit). The server passes your environment through to the Shopify CLI, so it is picked
up automatically.

Test it independently of Claude first:

```bash
SHOPIFY_CLI_THEME_TOKEN=shptka_xxxx shopify theme list --store my-store
```

If that lists your themes, the MCP server will work.

### Revoking a token

In the Theme Access app, open the **Passwords** page, click **Delete** next to the developer, and
confirm. Access is revoked immediately. Do this when someone leaves, or if a token is ever exposed.

### Alternative: interactive login

For local use only, you can skip the token entirely:

```bash
shopify theme list --store my-store
```

Complete the browser login and the CLI caches the session. This is fine on your own machine, but the
session expires and cannot be used headlessly — remote mode needs a Theme Access token.

---

## Install

```bash
git clone https://github.com/GOFORWRD/shopify-theme-mcp.git
cd shopify-theme-mcp
npm install
npm run build
mkdir -p ~/projects/my-theme   # local theme directory
```

`THEME_DIR` does not need to be a git repo or contain anything — the server initialises git on first
use and `theme_pull` will populate it.

---

## Claude Desktop (local, stdio)

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or
`%APPDATA%\Claude\claude_desktop_config.json` (Windows):

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

- `SHOPIFY_STORE` is the **handle only** — the part before `.myshopify.com`.
- Both paths must be absolute.
- **The explicit `PATH` matters.** Claude Desktop launches servers with a minimal environment, and
  the server shells out to `shopify` and `git`. Run `which shopify` and make sure that directory is
  in the list, or every tool call will fail with "command not found".
- Omit `SHOPIFY_CLI_THEME_TOKEN` if you used interactive login.
- Restart Claude Desktop after saving.

Then start it once and pull your theme: ask Claude to run `list_themes`, then `theme_pull`.

---

## Tools

Twelve tools. Anything that writes commits to git automatically.

| Tool | What it does | Key parameters |
|---|---|---|
| `list_themes` | List themes with IDs and roles (live / unpublished / development) | — |
| `theme_pull` | Download a theme into `THEME_DIR` and snapshot it in git | `theme_id` (omit = live), `only` (glob) |
| `list_files` | List local theme files | `filter` |
| `read_file` | Read a file with line numbers | `path`, line range |
| `search_files` | Grep theme files for text or regex | `query`, `is_regex`, `file_filter`, `max_results`, `include_hidden` |
| `write_file` | Create or overwrite a file → commits | `path`, `content` |
| `patch_file` | Exact find-and-replace → commits | `path`, `find`, `replace`, `allow_hidden` |
| `delete_file` | Delete a local file → commits | `path` |
| `theme_push` | Upload to Shopify | `theme_id`, `new_theme_name`, `only`, `allow_live` |
| `publish_theme` | Make a theme live | `theme_id`, `confirm` (must be `true`) |
| `git_history` | Show recent commits | `limit` |
| `git_revert_file` | Restore a file to an earlier commit | `path`, `commit` |

Writes are restricted to valid Shopify theme directories: `assets`, `blocks`, `config`, `layout`,
`locales`, `sections`, `snippets`, `templates`.

With `theme_id` omitted, `theme_push` creates a new unpublished theme named
`claude-edit-YYYY-MM-DD` unless you pass `new_theme_name`.

---

## Hidden and disabled content

**This is the behaviour most likely to surprise you.** Shopify marks sections and blocks that exist
in a template but aren't shown with `"disabled": true`. Themes accumulate a lot of these.

The server treats hidden content as off-limits by default:

- `search_files` **skips matches inside disabled sections/blocks** and tells you how many it skipped.
  Pass `include_hidden: true` to see them.
- `patch_file` **refuses to edit** inside disabled content unless you pass `allow_hidden: true`.

So if Claude reports "no matches" for text you can see in a template JSON file, the section is
probably disabled — the visible copy you actually meant is likely worded differently elsewhere.
Ask Claude to search again with `include_hidden`.

This exists because "change the headline" almost always means the *live* headline, and editing a
dormant section produces a change that appears to do nothing.

---

## Remote mode (HTTP)

The same server can run as a remote MCP endpoint, reachable from claude.ai, Claude Desktop and
mobile. Set `MCP_TRANSPORT=http` and it serves Streamable HTTP on localhost behind an unguessable
secret path segment.

```bash
export SHOPIFY_STORE=my-store
export THEME_DIR=/opt/my-theme
export SHOPIFY_CLI_THEME_TOKEN=shptka_xxxx
export MCP_TRANSPORT=http
export PORT=8787
export MCP_SECRET=$(openssl rand -hex 24)   # save this — it's your credential
node dist/index.js
```

| Endpoint | Method | Purpose |
|---|---|---|
| `/<MCP_SECRET>/mcp` | `POST` | MCP endpoint |
| `/healthz` | `GET` | Returns `ok`, for monitoring |

Anything else returns `404`. `MCP_SECRET` must be at least 16 characters or the server exits.
It binds to **`127.0.0.1` only** — put a tunnel or reverse proxy in front of it, never expose the
port directly.

Requests are stateless (a fresh server per request), but all filesystem, git and CLI work is
serialized through a global mutex, so concurrent sessions can't corrupt the repo.

### VPS setup (Ubuntu/Debian)

```bash
# 1. dependencies
# Node 22.12+ is required by the Shopify CLI
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt install -y nodejs git
sudo npm install -g @shopify/cli@latest

# 2. application
sudo mkdir -p /opt/shopify-theme-mcp /opt/my-theme
sudo git clone https://github.com/GOFORWRD/shopify-theme-mcp.git /opt/shopify-theme-mcp
cd /opt/shopify-theme-mcp && npm install && npm run build
```

Create `/etc/systemd/system/shopify-theme-mcp.service`:

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
Environment=MCP_SECRET=replace-with-openssl-rand-hex-24

[Install]
WantedBy=multi-user.target
```

The unit file holds live credentials — keep it at `0600` and outside the repo.

```bash
sudo chmod 600 /etc/systemd/system/shopify-theme-mcp.service
sudo systemctl daemon-reload && sudo systemctl enable --now shopify-theme-mcp
curl http://127.0.0.1:8787/healthz            # -> ok
curl -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/   # -> 404, as expected
```

### Expose it with a Cloudflare Tunnel

Add to your tunnel's ingress rules:

```yaml
  - hostname: shopify-theme.example.com
    service: http://localhost:8787
```

```bash
cloudflared tunnel route dns <tunnel-name> shopify-theme.example.com
sudo systemctl restart cloudflared
```

### Connect Claude

- **claude.ai / Desktop / mobile:** Settings → Connectors → Add custom connector →
  `https://shopify-theme.example.com/<MCP_SECRET>/mcp`
- **Local stdio:** omit `MCP_TRANSPORT` and use the Claude Desktop config above.

Seed the theme directory once on the host by calling `theme_pull` (or running
`shopify theme pull`) before your first editing session.

---

## Configuration reference

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `SHOPIFY_STORE` | yes | — | Store handle, e.g. `my-store` for `my-store.myshopify.com` |
| `THEME_DIR` | yes | — | Absolute path to the local theme directory |
| `SHOPIFY_CLI_THEME_TOKEN` | recommended | — | Theme Access password (`shptka_…`); required for headless use |
| `MCP_TRANSPORT` | no | stdio | Set to `http` for remote mode |
| `PORT` | no | `8787` | HTTP listen port (http mode only) |
| `MCP_SECRET` | http mode | — | Secret path segment, min 16 chars (`openssl rand -hex 24`) |

The server exits at startup if `SHOPIFY_STORE` or `THEME_DIR` is missing, or if `MCP_TRANSPORT=http`
without a valid `MCP_SECRET`. See [`.env.example`](.env.example).

---

## Typical session

> **You:** "Update the countdown in the announcement bar to say 'Last day for guaranteed delivery'"
>
> Claude pulls the live theme → searches for the text → patches the template JSON → pushes to a new
> unpublished theme → returns the preview URL → you review → you say "publish" → Claude publishes.

Every step is committed to git, so `git_history` and `git_revert_file` will undo anything.

---

## Security

- `SHOPIFY_CLI_THEME_TOKEN` and `MCP_SECRET` are credentials. Keep them in your Claude Desktop
  config or systemd unit — never commit them. `.gitignore` covers `.env`; the systemd unit lives
  outside the repo by design.
- **In remote mode the secret path *is* the credential.** Anyone with the full URL can read and
  rewrite your theme. URLs leak more readily than headers — shell history, proxy logs, config
  files — so rotate `MCP_SECRET` if it is ever exposed, and update your connector.
- The server binds to `127.0.0.1` only; a tunnel or proxy should be the sole public route.
- Prefer a Theme Access token over a full CLI login: it is scoped to themes and cannot reach orders
  or customer data.
- Live-theme changes always require an explicit flag (`allow_live`, `confirm`). Don't configure
  Claude to auto-approve those tools.

---

## Known limitations

- `theme_push` does **not** delete remote files that were deleted locally. Remove them via the
  Shopify admin, or run the CLI manually.
- Binary assets (images, fonts) sync but can't be read or edited via `read_file` / `patch_file`.
- If someone edits the theme in the Shopify admin at the same time, re-run `theme_pull` before
  editing or you may clobber their changes.
- `search_files` and `patch_file` hide disabled content by default — see
  [Hidden and disabled content](#hidden-and-disabled-content).

---

## Troubleshooting

**"Missing required env vars" on startup.** `SHOPIFY_STORE` or `THEME_DIR` isn't set. In Claude
Desktop they must be inside the server's `env` block, not your shell profile.

**`spawn shopify ENOENT` / "command not found".** Claude Desktop's minimal environment can't find
the Shopify CLI. Add its directory to the explicit `PATH` in your config — check with
`which shopify`.

**CLI asks for a browser login, or hangs in remote mode.** Set `SHOPIFY_CLI_THEME_TOKEN`.
Interactive sessions expire and can't work headlessly.

**Shopify CLI errors about the Node version.** The CLI requires Node 22.12+. Check with
`node --version`; upgrade with `nvm install 22 && nvm use 22`, or reinstall Node from your package
manager. This package's own `engines` field says 18+, but the CLI is the binding constraint.

**You lost the Theme Access password.** It can only be viewed once and the link expires after 7
days. Delete the entry on the Theme Access **Passwords** page and create a new one — see
[Getting a Theme Access token](#getting-a-theme-access-token).

**`401` / `Unauthorized` from theme commands.** The token was revoked, belongs to a different store,
or `SHOPIFY_STORE` doesn't match it. Verify outside Claude with
`SHOPIFY_CLI_THEME_TOKEN=… shopify theme list --store my-store`.

**Search finds nothing for text you can see.** The section is probably disabled — retry with
`include_hidden: true`. See [Hidden and disabled content](#hidden-and-disabled-content).

**Push refused with a live-theme message.** Working as intended. Push to an unpublished copy
(omit `theme_id`), preview it, then publish deliberately.

**404 from the tunnel.** Every path except `/<MCP_SECRET>/mcp` and `/healthz` returns 404. Check the
URL includes the full secret segment.

**Server exits immediately in http mode.** `MCP_SECRET` is missing or shorter than 16 characters.

---

## Licence

MIT — see [LICENSE](LICENSE).
