# claude-share

Single npm package (`@0xpv/claude-share`) exposing two binaries: `claude-share` (sharer) and `claude-connect` (receiver). Source lives in `claude-share/` and `claude-connect/` (shared code in `shared/`); both compile into `dist/` via `bun run build`. Supported on macOS, Linux and Windows on both sides.

## Dev commands

```bash
bun run dev:share                                # claude-share (TUNNEL=0 to skip bore, --direct / --public-host for direct mode)
bun run dev:connect --share=<url>                # claude-connect
# or directly:
bun claude-share/index.ts
bun claude-connect/index.ts --share=<url>
```

Build: `bun run build` (compiles both via bun build). Lint: `bun run lint`.

## Architecture

**Single public port** (default 2586): `port/detector.ts` sniffs first bytes — `CONNECT` goes to MITM proxy, TLS ClientHello (`0x16`) is terminated and piped to the Hono API on `PORT+1`, plain HTTP is piped to the Hono API on `PORT+1` (localhost-only). Bore tunnels PORT.

**MITM proxy** (`proxy/mitm.ts`): intercepts TLS only for `INTERCEPT_DOMAINS` (`api.anthropic.com`, `platform.anthropic.com`, `platform.claude.com`, `mcp-proxy.anthropic.com`). All other CONNECT requests are transparent TCP-piped — never touch the cert or plaintext.

**Token injection**: sharer's OAuth token is read from Claude Code's credential store (`shared/platforms/*`: Keychain on macOS, `~/.claude/.credentials.json` on Linux/Windows, honouring `CLAUDE_CONFIG_DIR`) and injected per-request inside the MITM. Never sent to receiver.

**Token refresh** (`proxy/token.ts` + `shared/oauth.ts`): the sharer refreshes the token itself 15 min before expiry via `POST platform.claude.com/v1/oauth/token` (Claude Code's public client id) and writes the rotated tokens back to the store so the sharer's own `claude` keeps working. Before refreshing it re-reads the store (Claude Code may have refreshed first). An upstream 401 triggers a refresh and is rewritten to a `503 + Retry-After` so the receiver's Claude Code retries instead of showing a login prompt.

**Model/feature parity**: Claude Code decides which models/modes to offer from `GET /api/claude_cli/bootstrap`, `/api/oauth/profile` and GrowthBook remote eval (`POST /api/eval/<sdk-key>`). These must stay allowlisted or the receiver only sees default models. `CLAUDE_CODE_OAUTH_TOKEN` must NOT be used on the receiver — it disables the bootstrap fetch. The receiver writes placeholder credentials whose `subscriptionType`/`rateLimitTier` mirror the sharer (sent in the pairing blob as `sharerSubscription`).

**Share modes**: `internet` (bore tunnel, auto-reconnect requesting the same remote port), `direct` (public IP / port-forward, `--public-host`), `lan`. All hosts/IPs a receiver may use go into the server cert SAN (`ca/serverCert.ts`).

**Connection hygiene** (`proxy/mitm.ts`): TCP keepalive + nodelay on every hop, upstream keep-alive agent, and Node server timeouts tuned (`requestTimeout` 3 min, `keepAliveTimeout` 60 s, idle 10 min). Node's default 5-minute `requestTimeout` was the source of multi-minute hangs on flaky tunnels.

**Pairing**: connect URL format is `http://<host>/connect/<pairingCode>`. The pairingCode is `base58(32-byte session key)` — it's also the private decryption key. Only the first 5 chars are sent over HTTP for session lookup; the receiver decrypts the response blob locally using the full key from the URL.

**Session key lifecycle**: `session.key` (32 bytes) → `session.pairingCode` (base58). Pressing `n` in TUI calls `regeneratePairingCode()` which zeroes nothing but replaces key+code and clears `pairingAttempts`. `destroySession()` zeroes the key.

## Security constraints — do not break

- Never log or transmit the full pairingCode over HTTP (it's the private key)
- Only send `pairingCode.slice(0, 5)` in the `/pair` POST body
- `INTERCEPT_DOMAINS` must stay minimal — non-Anthropic traffic must bypass the MITM
- Blocked on `api.anthropic.com`: `/v1/files`, `/v1/fine_tuning`, `/v1/assistants`, `/v1/messages/batches`, `/api/oauth/claude_cli/create_api_key`, `/api/oauth/file_upload`, `/api/oauth/files`, `/api/oauth/account`, `/api/oauth/organizations`
- Never log tokens (access or refresh) — `logger.*` calls in token code log only timings/state
- Rate limit: 5 attempts per known IP, 20 for `"unknown"` (bore doesn't forward real IPs)

## Receiver saved state

`~/.claude-share/connections/<machineId>.json` — pruned on startup if `sharedUntil` is past.  
`~/.claude-share/config.json` — device name.

## Known quirks

- `ensureBore()` must run **before** any `p.intro()`/`p.select()` calls. clack's `p.confirm()` tears down stdin in a way ink can't recover from if it runs after other prompts.
- `--share <url>` and `--share=<url>` are both supported in the receiver.
- bore doesn't set `x-forwarded-for`, so all bore requests arrive as `ip = "unknown"`.
- On Windows the receiver resets `cachedGrowthBookFeatures.tengu_windows_credman` to `false` before launch so Claude Code reads the placeholder file instead of Windows Credential Manager.
- `lint` covers `claude-share claude-connect shared` (there is no `src/` dir).
