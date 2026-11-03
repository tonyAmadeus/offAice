# AIROOM Native security notes / 安全說明

## Trust boundary

This port is **not** a sandbox for untrusted AI agents. Claude Code, Codex and any
children run with the user's OS account. A `workspace-write` argument or a clean
working-copy path **does not by itself prevent reads outside the workspace**. The
official CLIs can communicate with their vendors and can change their behavior in
new releases. Run the app only with CLI installations you trust, and preferably
using a dedicated standard (non-admin) macOS account for sensitive testing.

## Controls implemented

- macOS: application conversation state and backups encrypted by AES-256-GCM;
  random 256-bit key stored in the login Keychain, scoped to this machine.
- No token/password input fields; vendor CLI logins remain vendor-owned.
- Minimal environment passed to subprocesses; unknown variables (including
  `*TOKEN*`, `*API_KEY*`, `NODE_OPTIONS`, `DYLD_*`, proxies, SSH agent) excluded.
- Common credential file names and selected secret-text signatures excluded from
  every copied working directory. New secret-looking files in a write-copy cause
  review and writeback to fail closed.
- Read-only CLI commands use a filtered temporary copy, not the original cwd.
- Known credential signatures masked in displayed stdout and stderr; no app debug
  file collection.
- No automatic resend of requests after uncertain outcomes.

## Remaining risks

1. **No kernel-enforced network or filesystem isolation.** This is the largest
   remaining risk. The external CLI could open files outside its work copy and
   transmit data to any reachable host despite the UI's read-only label.
2. **Heuristics are not DLP.** Arbitrary tokens, secrets embedded in images,
   unknown formats and malicious symlink races may be missed.
3. **Vendor supply-chain risk.** Verify installed CLIs, their updater behavior,
   scripts, runtime, native extensions and child processes independently.
4. **Local staging data are not encrypted at rest.** Work copies may contain
   ordinary project material and are not included in encrypted state backups.
5. **Cancelled child trees.** `Process.terminate()` does not guarantee all spawned
   grandchildren are stopped.
6. **Encrypted backups are device-bound.** Losing the Keychain key or migrating
   to another Mac may make them unreadable. An authenticated export/recovery
   mechanism has not yet been implemented.
7. Apple Silicon build/signing/Keychain integration and runtime networking
   require validation on a real Mac. Linux tests do not validate those paths.

## Recommended verification on an Apple Silicon Mac

Run `swift test`, `Scripts/package-app.sh`, and `Scripts/audit-arm64.sh`.
In an isolated test account, verify: Keychain create/read/lock behavior,
legacy JSON migration, backup restoration/tampering, working-copy filtering,
CLI login with allowlisted environment, `lsof -i -n -P` and firewall/network
captures during use, process descendants after cancellation, and file reads
outside the chosen work copy. Compare any distributed binary with a trusted
local build; macOS signing/notarization is not yet part of this source package.

If a CLI cannot operate without a proxy, system OAuth token, SSH agent or
other inherited environment variable, it may require explicit per-provider
configuration rather than loosening the global environment filter.

### Codex App Server adapter (native)

AIROOM launches its own `codex app-server --listen stdio://` process, using the
launcher included with the official ChatGPT.app or Codex.app when available.
It does not attach to desktop App internals or copy authentication secrets.
Each AIROOM turn uses an ephemeral app-server thread to avoid double-injecting
shared conversations. Codex tool approvals are declined automatically; the
user must still review project changes before writing back.

The App Server adapter is *not* a system security boundary. The vendor binary
inherits user-level filesystem access and can use the network; current config
may enable vendor MCP servers. AIROOM restricts task workspace and environment
but cannot prevent all accesses to files outside it. For sensitive repositories,
use an additional macOS account or OS-enforced sandbox.

### Claude Desktop bundled CLI

Claude Desktop's **Code** tab downloads/maintains a versioned Claude Code
binary under `~/Library/Application Support/Claude/claude-code/<version>/`.
AIROOM selects the highest numeric compatible version (either `claude.app/Contents/MacOS/claude`
or the older standalone `claude`) and falls back to an independently installed
`claude` on `PATH`. AIROOM does **not** read Claude credential files or browser
cookies, nor does it install or edit the vendor's binary. Because paths change
across updates, macOS may show fresh privacy-permission prompts. The Code tab
must be opened at least once to install its bundled runtime. Claude Code
sign-in may still require validation independent of the Desktop GUI.
