# code-share

Single npm package (`@gurshabad90/code-share`, a renamed fork of `@0xpv/claude-share`) exposing two binaries: `code-share` (sharer) and `code-connect` (receiver). The sharer shares **one tool per session** — Claude Code (`claude`) or ChatGPT via the OpenAI Codex CLI (`codex`); `shared/tool.ts` (`ShareTool`) is the discriminator used everywhere. State lives in `~/.code-share` (`shared/paths.ts` migrates `~/.claude-share` on first run); connect links use `codeshare://` but `claudeshare://` is still parsed. Source lives in `code-share/` and `code-connect/` (shared code in `shared/`); both compile into `dist/` via `bun run build`. Supported on macOS, Linux and Windows on both sides.

## Dev commands

```bash
bun run dev:share                                # code-share (TUNNEL=0 to skip bore, --direct / --public-host for direct mode)
bun run dev:connect --share=<url>                # code-connect
# or directly:
bun code-share/index.ts
bun code-connect/index.ts --share=<url>
```

Build: `bun run build` (compiles both via bun build). Lint: `bun run lint`.

## Architecture

**Single public port** (default 2569): `port/detector.ts` sniffs first bytes — `CONNECT` goes to MITM proxy, TLS ClientHello (`0x16`) is terminated and piped to the Hono API on `PORT+1`, plain HTTP is piped to the Hono API on `PORT+1` (localhost-only). Bore tunnels PORT.

**MITM proxy** (`proxy/mitm.ts` + `proxy/policy.ts`): `createMitmProxy(certHosts, checkAuth, policy)` — the `ToolPolicy` (`policyFor(tool)`) owns the intercept list, allow/deny rules, header stripping and the error-body shape. Claude intercepts `api.anthropic.com`, `platform.anthropic.com`, `platform.claude.com`, `mcp-proxy.anthropic.com`; Codex intercepts only `chatgpt.com`. All other CONNECT requests are transparent TCP-piped — never touch the cert or plaintext. Websocket upgrades inside an intercepted host go through `proxy.onWebSocketConnection` (same allow-list, same header injection; deny = close 1008, upstream non-101 = close 1011) — Codex streams Responses over `wss://chatgpt.com/backend-api/codex/responses` by default.

**Token injection**: `getAuthHeaders()` in `proxy/token.ts` returns the headers to inject for the active tool — Claude: `authorization`; Codex: `authorization` + `chatgpt-account-id`. Claude tokens come from Claude Code's credential store (`shared/platforms/*`: Keychain on macOS, `~/.claude/.credentials.json` on Linux/Windows, honouring `CLAUDE_CONFIG_DIR`); Codex tokens from `shared/codex/store.ts` (`$CODEX_HOME/auth.json`, default `~/.codex/auth.json`, or the macOS keychain item `Codex Auth` / `cli|<sha256(codex_home)[:16]>`). Never sent to receiver.

**Token refresh** (`proxy/tokenManager.ts` generic single-flight refresher, `proxy/token.ts` per-tool adapters, `shared/oauth.ts` + `shared/codex/oauth.ts`): the sharer refreshes the token itself 15 min before expiry — Claude via `POST platform.claude.com/v1/oauth/token`, Codex via `POST auth.openai.com/oauth/token` (Codex's public client id `app_EMoamEEZ73f0CkXaXp7hrann`, JSON body) — and writes the rotated tokens back to the store so the sharer's own CLI keeps working (Codex: also `last_refresh`, which Codex requires to be < 8 days old). Before refreshing it re-reads the store (the CLI may have refreshed first). An upstream 401 on the tool's auth host triggers a refresh and is rewritten to a `503 + Retry-After` with a tool-shaped error body so the receiver's CLI retries instead of showing a login prompt.

**Model/feature parity**: Claude Code decides which models/modes to offer from `GET /api/claude_cli/bootstrap`, `/api/oauth/profile` and GrowthBook remote eval (`POST /api/eval/<sdk-key>`). These must stay allowlisted or the receiver only sees default models. `CLAUDE_CODE_OAUTH_TOKEN` must NOT be used on the receiver — it disables the bootstrap fetch. The receiver writes placeholder credentials whose `subscriptionType`/`rateLimitTier` mirror the sharer (sent in the pairing blob as `sharerSubscription`).

**Share modes**: `internet` (bore tunnel, auto-reconnect requesting the same remote port), `direct` (public IP / port-forward, `--public-host`), `lan`. All hosts/IPs a receiver may use go into the server cert SAN (`ca/serverCert.ts`).

**Connection hygiene** (`proxy/mitm.ts`): TCP keepalive + nodelay on every hop, upstream keep-alive agent, and Node server timeouts tuned (`requestTimeout` 3 min, `keepAliveTimeout` 60 s, idle 10 min). Node's default 5-minute `requestTimeout` was the source of multi-minute hangs on flaky tunnels.

**Pairing**: connect URL format is `codeshare://<host>/connect/<pairingCode>[?tool=codex]`. The pairingCode is `base58(32-byte session key)` — it's also the private decryption key. Only the first 5 chars are sent over HTTP for session lookup; the receiver decrypts the response blob locally using the full key from the URL. `ConnectionFile.tool` (in the encrypted blob) is authoritative for which CLI the receiver launches; the `?tool=` query is only a display hint and is omitted for Claude so old receivers keep working. Codex blobs reuse `sharerAccount.emailAddress` (from the id_token) and `sharerSubscription.subscriptionType` = ChatGPT plan type.

**Receiver launch** (`code-connect/launch.ts` `launchTool`, `code-connect/codex.ts`): dispatches on `SavedConnection.tool ?? "claude"`. Codex: `npm install -g @openai/codex` if missing, `codex update` before each launch, placeholder `auth.json` (`refresh_token === "code-share-placeholder"`, unsigned JWTs carrying the sharer's plan, `last_refresh` rewritten every launch) only when no real login exists, env `HTTPS_PROXY`/`HTTP_PROXY` + `CODEX_CA_CERTIFICATE` (never `SSL_CERT_FILE` — rustls treats it as *replacing* the roots), `OPENAI_API_KEY`/`OPENAI_BASE_URL` removed.

**Session key lifecycle**: `session.key` (32 bytes) → `session.pairingCode` (base58). Pressing `n` in TUI calls `regeneratePairingCode()` which zeroes nothing but replaces key+code and clears `pairingAttempts`. `destroySession()` zeroes the key.

## Security constraints — do not break

- Never log or transmit the full pairingCode over HTTP (it's the private key)
- Only send `pairingCode.slice(0, 5)` in the `/pair` POST body
- `interceptDomains` in `proxy/policy.ts` must stay minimal — traffic to anything but the shared tool's API hosts must bypass the MITM
- Blocked on `api.anthropic.com`: `/v1/files`, `/v1/fine_tuning`, `/v1/assistants`, `/v1/messages/batches`, `/api/oauth/claude_cli/create_api_key`, `/api/oauth/file_upload`, `/api/oauth/files`, `/api/oauth/account`, `/api/oauth/organizations`
- Blocked on `chatgpt.com`: `/backend-api/wham/rate-limit-reset-credits/consume`, `/backend-api/wham/tasks`, `/backend-api/wham/workspace-messages`, `/backend-api/codex/memories`, `/backend-api/codex/images`, `/backend-api/codex/realtime`, `/backend-api/codex/files`, `/ps/apps` — and everything not explicitly allowed (only `GET`/`POST` on `/backend-api/codex/responses*`, `GET /backend-api/codex/models`, `POST /backend-api/codex/alpha/search` and read-only `GET /backend-api/wham/{usage,rate-limit-reset-credits,accounts/check,profiles/me,config/bundle,settings/user}`)
- Receiver-sent `cookie`, `openai-organization`, `openai-project`, `x-api-key` never reach upstream
- Never log tokens (access or refresh) — `logger.*` calls in token code log only timings/state
- Rate limit: 5 attempts per known IP, 20 for `"unknown"` (bore doesn't forward real IPs)

## Receiver saved state

`~/.code-share/connections/<machineId>.json` (includes `tool`) — pruned on startup if `sharedUntil` is past.  
`~/.code-share/config.json` — device name.

## Known quirks

- Any clack prompt/spinner leaves stdin with a stale readline `data` listener in paused mode, which makes ink's `useInput` deaf. `resetStdinForInk()` in `code-share/index.ts` must run right before `render()` — keep it there if you add prompts.
- Fable/new models on the receiver come from `GET /api/claude_cli/bootstrap`, which the API answers based on the *receiver's* Claude Code version (User-Agent). An outdated `claude` on the receiver won't list them no matter what the proxy does.
- `--share <url>` and `--share=<url>` are both supported in the receiver.
- bore doesn't set `x-forwarded-for`, so all bore requests arrive as `ip = "unknown"`.
- On Windows the receiver resets `cachedGrowthBookFeatures.tengu_windows_credman` to `false` before launch so Claude Code reads the placeholder file instead of Windows Credential Manager.
- `lint` covers `code-share code-connect shared` (there is no `src/` dir).
- Codex only reads `auth.json` when `cli_auth_credentials_store` is `file` (the default) or `auto`; a receiver configured for `keyring` will not see the placeholder.
- Codex caches auth in-process — the sharer's Codex only picks up a rotated token written by code-share on its next start, exactly like Claude Code.
- `codex --version` prints `codex-cli X.Y.Z`; `claude --version` prints `X.Y.Z (Claude Code)` — version parsing differs per tool.
- Testing the MITM under `bun` gives bogus TLS errors (bun's `tls`/`ws` polyfills); test proxy behaviour under Node (`bun build --target=node` then `node`).
