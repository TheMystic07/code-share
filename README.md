# claude-relay

Securely Share your claude-code subscription with your friends.

One machine runs **claude-share** to expose its Claude credentials through a local proxy. Other machines run **claude-receive** to connect to it and use Claude Code as if they had their own subscription.

---

## How it works

```
Receiver machine                    Sharer machine
─────────────────                   ──────────────────────────────
claude (CLI)                        claude-share
  │                                   │
  │  HTTPS_PROXY=...                  ├─ MITM proxy (intercepts Anthropic API calls)
  └──────────────────────────────────>│    injects sharer's OAuth token
                                      │
                                      ├─ Hono API (pairing, health, CA cert)
                                      │
                                      └─ bore tunnel (public URL via bore.pub)
```

- The sharer's OAuth token is never written to disk or sent to the receiver — it's injected per-request inside the MITM proxy.
- The receiver installs a temporary CA cert (valid only for the session) so the MITM can intercept Anthropic traffic. Non-Anthropic domains (MCP servers, telemetry, etc.) pass through as a raw TCP tunnel — not inspected.
- Pairing uses a one-time code. Once paired, the receiver's credentials are saved so reconnecting skips the pairing step.

---

## Packages

| Package          | npm                    | Description                                              |
| ---------------- | ---------------------- | -------------------------------------------------------- |
| `claude-share`   | `@0xpv/claude-share`   | Run on the machine with the Claude subscription          |
| `claude-receive` | `@0xpv/claude-receive` | Run on machines that want to use the shared subscription |

---

## Quickstart

### Sharer

```bash
npx @0xpv/claude-share
```

Requires [bore](https://github.com/ekzhang/bore) for internet sharing (`cargo install bore-cli` or `brew install bore-cli`). If bore is not installed you'll be prompted — decline to share on LAN only.

The TUI shows connection URLs. Share the **Public** URL with receivers over the internet, or the **LAN** URL for local network.

**Keys:** `c` copy URL · `q` quit

### Receiver

```bash
# First time — paste the connect URL from the sharer's TUI
npx @0xpv/claude-receive --share <connect-url>

# Subsequent runs — pick from saved connections
npx @0xpv/claude-receive
```

The receiver configures Claude Code to route through the proxy and installs the session CA cert automatically. Everything is cleaned up on exit.

---

## Requirements

- **Node.js 18+** on both machines
- **bore** (`brew install bore-cli`) on the sharer machine for internet sharing
- The sharer must be logged in to Claude Code (`claude login`)
- The receiver must have Claude Code installed

---

## Security model

- The sharer's OAuth token is read from the macOS Keychain and injected into requests in-memory. It is never transmitted to the receiver.
- Only these Anthropic endpoints are proxied: `POST /v1/messages`, `GET /v1/models`, `/api/hello`, and OAuth flows on `platform.anthropic.com` / `platform.claude.com`.
- File upload (`/v1/files`), fine-tuning, and assistants endpoints are blocked.
- All non-Anthropic HTTPS traffic passes through as an opaque TCP tunnel — the proxy never sees the contents.
- Sessions expire after the duration chosen at startup (6h / 24h / 1 week).

---

## Development

```bash
# Sharer
cd claude-share
bun dev

# Receiver
cd claude-receive
bun dev --share <connect-url>
```

Set `TUNNEL=0` to skip the bore tunnel during local development.
