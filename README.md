# opencode-claude-proxy

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

An [OpenCode plugin](https://opencode.ai/docs/plugins/) that lets you use [OpenCode](https://opencode.ai) with your [Claude Max](https://claude.ai) subscription.

## How It Works

```
┌─────────────┐       ┌────────────────────┐       ┌─────────────────┐
│  OpenCode   │──────▶│  Claude Max Proxy  │──────▶│    Anthropic    │
│  (TUI/Web)  │ :3456 │   (local server)   │  SDK  │    Claude Max   │
│             │◀──────│                    │◀──────│                 │
└─────────────┘       └────────────────────┘       └─────────────────┘
```

[OpenCode](https://opencode.ai) speaks the Anthropic REST API. Claude Max provides access via the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) (not the REST API). The [opencode-claude-max-proxy](https://github.com/rynfar/opencode-claude-max-proxy) bridges the gap — it accepts API requests from OpenCode and translates them into Agent SDK calls using your Claude Max session.

This plugin manages the proxy lifecycle automatically: it starts the proxy when OpenCode launches, health-checks it, and cleans up on exit.

## Quick Start

### 1. Authenticate with Claude (one-time)

```bash
npm install -g @anthropic-ai/claude-code
claude login
```

### 2. Add to your `opencode.json`

Global (`~/.config/opencode/opencode.json`) or project-level:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-claude-proxy"],
  "provider": {
    "anthropic": {
      "options": {
        "baseURL": "http://127.0.0.1:3456",
        "apiKey": "dummy"
      }
    }
  }
}
```

### 3. Run OpenCode

```bash
opencode
```

That's it. The plugin handles everything.

## Prerequisites

- **Node.js >= 18** — [nodejs.org](https://nodejs.org)
- **Claude Max subscription** — the $100/mo plan on [claude.ai](https://claude.ai)

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `CLAUDE_PROXY_PORT` | `3456` | Port for the proxy server (must match `baseURL` in config) |

## Troubleshooting

### "Claude Code CLI not found"

```bash
npm install -g @anthropic-ai/claude-code
```

### "Claude not authenticated"

```bash
claude login
```

This opens a browser for OAuth. Your Claude Max subscription credentials are needed.

### "Proxy failed to start"

1. Check Claude auth: `claude auth status`
2. Check if the port is in use: `lsof -i :3456`
3. Try a different port: set `CLAUDE_PROXY_PORT=4567` and update `baseURL` in `opencode.json` to match

### "Proxy didn't become healthy within 10 seconds"

The proxy takes a moment to initialize. If this persists:
- Ensure `claude auth status` shows `loggedIn: true`
- Check your internet connection

## Development

### Project Structure

```
opencode-claude-proxy/
├── src/
│   └── index.ts           # Plugin entry point
├── test/
│   ├── run.sh             # Test runner
│   └── opencode.json      # Test config
├── package.json
└── tsconfig.json
```

### Build

```bash
npm install
npm run build
```

### Test locally

```bash
./test/run.sh              # Build and launch OpenCode with the plugin
./test/run.sh --clean      # Remove build artifacts
```

The test script builds the plugin, creates a temp workspace with `.opencode/plugins/` configured, and launches OpenCode with the plugin loaded locally.

## FAQ

**Do I need an Anthropic API key?**

No. The proxy authenticates through your Claude Max subscription via `claude login`. The `ANTHROPIC_API_KEY=dummy` value is just a placeholder that OpenCode requires — it's never actually used.

**What happens if my Claude Max subscription expires?**

The proxy will fail to authenticate. Run `claude auth status` to check. You'll need an active Claude Max ($100/mo) or Claude Max with Team ($200/mo) subscription.

**Is this the same as using the Anthropic API?**

Not exactly. The proxy translates between the Anthropic REST API format and the Claude Agent SDK. From OpenCode's perspective it looks like the API, but under the hood it uses your Claude Max session. Rate limits are determined by your Claude Max subscription, not API tier limits.

**Why `claude login` instead of an API key?**

Claude Max doesn't provide API access. Authentication goes through the Claude Code CLI's OAuth flow, which grants an Agent SDK session token tied to your subscription.

## Disclaimer

This project is an **unofficial wrapper** around Anthropic's publicly available Claude Agent SDK and OpenCode. It is not affiliated with, endorsed by, or supported by Anthropic or OpenCode.

**Use at your own risk.** The authors make no claims regarding compliance with Anthropic's Terms of Service. It is your responsibility to review and comply with Anthropic's [Terms of Service](https://www.anthropic.com/terms) and [Authorized Usage Policy](https://www.anthropic.com/aup). Terms may change at any time.

This project calls publicly available npm packages using your own authenticated account. No API keys are intercepted, no authentication is bypassed, and no proprietary systems are reverse-engineered.

## Credits

Built on top of [opencode-claude-max-proxy](https://github.com/rynfar/opencode-claude-max-proxy) by [@rynfar](https://github.com/rynfar), which provides the core proxy that bridges the Anthropic Agent SDK to the standard API.

Powered by the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) by Anthropic and [OpenCode](https://opencode.ai).

## License

MIT
