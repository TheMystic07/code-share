# claude-relay

Two npm packages: `claude-share` (sharer) and `claude-receive` (receiver).

## Dev commands

```bash
cd claude-share && bun dev          # TUNNEL=0 to skip bore
cd claude-receive && bun dev --share=<url>
```

Build: `npm run build` in each package. Lint: `oxlint`.

## Architecture

**Single public port** (default 2586): `port/detector.ts` sniffs first bytes — `CONNECT` goes to MITM proxy, TLS ClientHello (`0x16`) is terminated and piped to the Hono API on `PORT+1`, plain HTTP is piped to the Hono API on `PORT+1` (localhost-only). Bore tunnels PORT.

**MITM proxy** (`proxy/mitm.ts`): intercepts TLS only for `INTERCEPT_DOMAINS` (`api.anthropic.com`, `platform.anthropic.com`, `platform.claude.com`, `mcp-proxy.anthropic.com`). All other CONNECT requests are transparent TCP-piped — never touch the cert or plaintext.

**Token injection**: sharer's OAuth token is read from macOS Keychain at startup and injected per-request inside the MITM. Never written to disk, never sent to receiver.

**Pairing**: connect URL format is `http://<host>/connect/<pairingCode>`. The pairingCode is `base58(32-byte session key)` — it's also the private decryption key. Only the first 5 chars are sent over HTTP for session lookup; the receiver decrypts the response blob locally using the full key from the URL.

**Session key lifecycle**: `session.key` (32 bytes) → `session.pairingCode` (base58). Pressing `n` in TUI calls `regeneratePairingCode()` which zeroes nothing but replaces key+code and clears `pairingAttempts`. `destroySession()` zeroes the key.

## Security constraints — do not break

- Never log or transmit the full pairingCode over HTTP (it's the private key)
- Only send `pairingCode.slice(0, 5)` in the `/pair` POST body
- `INTERCEPT_DOMAINS` must stay minimal — non-Anthropic traffic must bypass the MITM
- Blocked on `api.anthropic.com`: `/v1/files`, `/v1/fine_tuning`, `/v1/assistants`
- Rate limit: 5 attempts per known IP, 20 for `"unknown"` (bore doesn't forward real IPs)

## Receiver saved state

`~/.claude-share/connections/<machineId>.json` — pruned on startup if `sharedUntil` is past.  
`~/.claude-share/config.json` — device name.

## Known quirks

- `ensureBore()` must run **before** any `p.intro()`/`p.select()` calls. clack's `p.confirm()` tears down stdin in a way ink can't recover from if it runs after other prompts.
- `--share <url>` and `--share=<url>` are both supported in the receiver.
- bore doesn't set `x-forwarded-for`, so all bore requests arrive as `ip = "unknown"`.
