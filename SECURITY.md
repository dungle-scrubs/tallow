# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.4.x   | ✅ |

## Credential handling model

Tallow does **not** store raw API keys in normal persistence flows.

- `~/.tallow/auth.json` stores provider metadata and **key references**
- Raw keys are stored in OS keychain (macOS) or supplied as references
  (`op://...`, `!command`, or `ENV_VAR_NAME`)
- `auth.json` must use file mode `0600`; startup fails when permissions
  are looser

### auth.json shape

```json
{
  "anthropic": { "type": "api_key", "key": "!security find-generic-password ..." },
  "openai": { "type": "api_key", "key": "OPENAI_API_KEY" }
}
```

## Migration behavior

On startup, Tallow runs a one-time migration for existing `auth.json`
entries that contain plaintext API keys.

- Plaintext values are moved to secure storage (keychain or reference)
- `auth.json` entries are rewritten to references
- If migration cannot secure a plaintext key, startup fails (no silent
  plaintext fallback)

## Operational guidance

- Do not pass secrets via CLI flags (`--api-key` was removed)
- Use env vars for runtime:
  - `TALLOW_API_KEY` (raw runtime value)
  - `TALLOW_API_KEY_REF` (reference value)
- For non-interactive install:
  - `TALLOW_API_KEY=... tallow install -y --default-provider anthropic`
  - `TALLOW_API_KEY_REF=op://Vault/Item/field tallow install -y --default-provider anthropic`
- In CI, prefer provider env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.)

## Reporting a vulnerability

Please report security vulnerabilities by emailing **kevin@frilot.com**.

Do **not** open a public issue for security vulnerabilities.
