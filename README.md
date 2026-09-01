# code-share

Securely share your Claude Code subscription with your other machines (or a friend).

> Fork of [`@0xpv/claude-share`](https://github.com/prathamVaidya/claude-share), renamed to `code-share` / `code-connect` and published as `@gurshabad90/code-share`. Old `claudeshare://` links and `~/.claude-share` state are still accepted/migrated.

One machine runs **code-share** to expose its Claude credentials through a local proxy. Other machines run **code-connect** to connect and use Claude Code as if they had their own subscription.

---

## How it works

```
Receiver machine                    Sharer machine
─────────────────                   ──────────────────────────────
claude (CLI)                        code-share
  │                                   │
  │  HTTPS_PROXY=...                  ├─ MITM proxy (intercepts Anthropic API calls)
  └──────────────────────────────────>│    injects sharer's OAuth token
                                      │
                                      ├─ Hono API (pairing, health, CA cert)
                                      │
                                      └─ bore tunnel (public URL via tunnel.mystic.cat)
```

- The sharer's OAuth token is read from Claude Code's credential store (macOS Keychain, or `~/.claude/.credentials.json` on Linux/Windows) and injected per-request inside the MITM proxy — it is never sent to the receiver.
- The sharer refreshes the OAuth token itself before it expires (and on any upstream 401), writing the rotated token back to the same store Claude Code uses — no more "run `claude` on the server to fix the token".
- The receiver installs a temporary CA cert (valid only for the session) so the MITM can intercept Anthropic traffic. Non-Anthropic domains pass through as an opaque TCP tunnel — never inspected.
- Pairing uses a one-time code. Once paired, credentials are saved so reconnecting skips the pairing step.

---

## Install

```bash
npm install -g @gurshabad90/code-share
```

This installs both `code-share` and `code-connect` binaries.

---

## Quickstart

### Sharer

```bash
code-share
```

You'll be asked how to share:

| Mode | When to use |
|---|---|
| **Internet** | Tunnel via [bore](https://github.com/ekzhang/bore) through `tunnel.mystic.cat` (auto-installed on macOS/Linux/Windows). Auto-reconnects on the same port if it drops. Override the server/secret with `boreServer` / `boreSecret` in `~/.code-share/config.json` or `BORE_SERVER` / `BORE_PASSWORD` env vars. |
| **LAN only** | Both machines on the same network. |

Flags: `--mode internet|lan`, `--port <n>` (default 2569), `TUNNEL=0` (LAN only). A hidden `--mode direct` / `--public-host host[:port]` exists for machines with a public IP (no tunnel).

The TUI shows connection URLs plus live token and tunnel status. Share the **Public** URL with receivers over the internet, or the **LAN** URL for local network.

**Keys:** `c` copy URL · `n` new pairing code · `q` quit

### Receiver

```bash
# First time — paste the connect URL from the sharer's TUI
code-connect --share <connect-url>

# Subsequent runs — pick from saved connections
code-connect
```

The receiver configures Claude Code to route through the proxy and installs the session CA cert automatically. Everything is cleaned up on exit.

Every launch first runs `claude update` (and installs Claude Code if it's missing) so the receiver always has the current client — new models/modes are advertised per client version. Skip with `--no-update` or `CODE_CONNECT_NO_UPDATE=1`.

The receiver machine does **not** need a Claude subscription or login: placeholder credentials are created that mirror the sharer's plan, so Claude Code shows the same models and modes (Opus/Sonnet/Fable, ultra code, 1M context, …) as on the sharer's machine.

---

## One-time use (npx)

```bash
# Sharer
npx @gurshabad90/code-share

# Receiver
npx -p @gurshabad90/code-share code-connect --share <connect-url>
```

---

## Requirements

- **Node.js 18+** on both machines
- **macOS, Linux or Windows** on either side
- **bore** for tunnel mode on the sharer machine — auto-installed from GitHub releases if missing (falls back to `brew`/`cargo`)
- The sharer must be logged in to Claude Code (`claude login`)
- The receiver must have Claude Code installed (no login needed)

---

## Security model

- The sharer's OAuth token is read from Claude Code's credential store and injected into requests in-memory. It is never transmitted to the receiver.
- Only the Anthropic endpoints Claude Code needs to behave like a logged-in client are proxied: inference (`POST /v1/messages`, `count_tokens`), model discovery (`GET /v1/models`, `GET /api/claude_cli/bootstrap`), account/usage display (`/api/oauth/profile`, `/api/oauth/usage`, `/api/oauth/validate`, `/api/oauth/claude_cli/roles`), feature gates (`POST /api/eval*`), org settings (`GET /api/claude_code/settings`, `policy_limits`), `/api/hello`, and OAuth flows on `platform.anthropic.com` / `platform.claude.com`.
- Anything that could create long-lived artefacts or credentials on the sharer's account is blocked: API-key creation, file upload, `/v1/files`, batches, fine-tuning, assistants, account/organization settings.
- All non-Anthropic HTTPS traffic passes through as an opaque TCP tunnel — the proxy never sees the contents.
- Sessions expire after the duration chosen at startup (6h / 24h / 1 week / 30 days).

---

## Troubleshooting

- **Requests hang / "stuck" mid-turn** — every hop now uses TCP keepalive and short request timeouts, so a dropped tunnel fails fast and Claude Code retries by itself. If it keeps happening, check the tunnel server (`~/.code-share/logs/share.log` shows bore reconnects).
- **"The sharer's token expired — refreshing it now"** — transient; the sharer refreshes and Claude Code retries. If the TUI shows `token dead`, run `claude login` on the sharer machine.
- **Models missing on the receiver** — make sure both sides run ≥ 1.4.0 and re-pair (`code-connect --share <url>`); the receiver's placeholder credentials are updated to match the sharer's plan.
- Logs: `~/.code-share/logs/share.log` (sharer) and `connect.log` (receiver).

---

## Development

```bash
# Sharer
bun run dev:share            # TUNNEL=0 for LAN only, --direct / --public-host for direct mode

# Receiver
bun run dev:connect --share <connect-url>
```

Set `TUNNEL=0` to skip the bore tunnel during local development.

Build: `bun run build` — compiles both binaries into their `dist/` folders.
