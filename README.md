# telemost-mcp-server

Pay-per-call **Telegram analytics** as MCP tools. Your agent pays per call in **USDC** via the
[x402](https://x402.org) protocol — **no accounts, no API keys, no subscription**. Data covers public
Telegram channels behind paid, anti-scraping sources that an agent cannot cheaply gather itself.

## Why this server

- **Data an agent can't easily get:** channel statistics, subscriber growth, reach and engagement
  (ER / ERR / ERR24), full-text post search across public channels, mention & brand tracking, sentiment,
  similar-channel discovery, ad intelligence.
- **No signup / no keys:** pay per call in USDC (x402). Fund a wallet, that's it.
- **19 paid tools + a free `telemost_catalog`** tool (list everything, no payment).
- **Base + Solana** (USDC). Pick either network per call.
- **Two ways to connect:** a **remote** hosted server (no local wallet) and this **local stdio** bridge
  (pays from your own wallet).
- **Production, observable, listed:** live at `https://api.telemost.io`, listed on
  [x402scan](https://www.x402scan.com/resources) and the x402 Bazaar.

Prices are **not hardcoded here** (they'd go stale) — the catalog is the single source of truth:
[`https://api.telemost.io/v1/catalog`](https://api.telemost.io/v1/catalog).

## Quickstart (no wallet, no money)

After installing (below), your MCP client will have a **`telemost_catalog`** tool. Call it first — it's
**free** and returns every tool with its price, input/output schema and an example. First success before
your first dollar. Only paid tools (e.g. `telemost_channel_info`) require a funded wallet.

## Install

Requires **Node ≥ 18**. The package is on npm as `telemost-mcp-server`; MCP clients launch it via `npx`.

### Claude Desktop

Edit `claude_desktop_config.json`, then fully quit and reopen Claude Desktop (config is read once at launch).

| OS | Config file |
|---|---|
| **macOS** | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| **Windows** | `%APPDATA%\Claude\claude_desktop_config.json` |
| **Linux** | `~/.config/Claude/claude_desktop_config.json` |

> **Windows (Microsoft Store / MSIX build):** the app sandboxes `%APPDATA%\Claude\` and redirects it to
> `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\`. Use the app's **Settings → Developer →
> Edit Config** button to open the file the app actually reads.

**macOS / Linux:**

```json
{
  "mcpServers": {
    "telemost": {
      "command": "npx",
      "args": ["-y", "telemost-mcp-server"],
      "env": {
        "EVM_PRIVATE_KEY": "0xYOUR_BASE_WALLET_KEY",
        "MAX_PAYMENT_USDC": "0.5",
        "SESSION_MAX_USDC": "5"
      }
    }
  }
}
```

**Windows** — if a bare `npx` command fails to start, wrap it with `cmd /c`:

```json
{
  "mcpServers": {
    "telemost": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "telemost-mcp-server"],
      "env": {
        "EVM_PRIVATE_KEY": "0xYOUR_BASE_WALLET_KEY",
        "MAX_PAYMENT_USDC": "0.5",
        "SESSION_MAX_USDC": "5"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add telemost --env EVM_PRIVATE_KEY=0xYOUR_KEY -- npx -y telemost-mcp-server
```

### Cursor

`~/.cursor/mcp.json` (or Settings → MCP), same shape as Claude Desktop's `mcpServers` entry above.

Sources for client config paths: [modelcontextprotocol.io — connect local servers](https://modelcontextprotocol.io/docs/develop/connect-local-servers),
[Claude Desktop configuration](https://claude.com/docs/third-party/claude-desktop/configuration).

## Remote server (no local wallet needed)

A hosted MCP server is live at **`https://api.telemost.io/mcp`** (Streamable HTTP). Point any MCP client
that supports remote/Streamable-HTTP servers at that URL. Minimal programmatic example:

```ts
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createx402MCPClient } from "@x402/mcp";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const client = createx402MCPClient({
  name: "my-agent", version: "1.0",
  schemes: [{ network: "eip155:8453", client: new ExactEvmScheme(privateKeyToAccount(process.env.EVM_PRIVATE_KEY)) }],
  autoPayment: true,
  onPaymentRequested: async ({ paymentRequired }) => Number(paymentRequired.accepts[0].maxAmountRequired) <= 20_000, // <= $0.02
});
await client.connect(new StreamableHTTPClientTransport(new URL("https://api.telemost.io/mcp")));

await client.callTool("telemost_catalog", {});                       // free
await client.callTool("telemost_channel_info", { channel: "@durov" }); // paid
```

## Example calls

- `telemost_catalog` → `{ "service": "telemost-x402", "resources": [ … ], "mcp": { … } }` (free).
- `telemost_channel_info` `{ "channel": "@durov" }` → an envelope like:

```json
{ "ok": true,
  "data": { "title": "…", "members_count": 0, "verified": true, "language": "en", "link": "https://t.me/…" },
  "meta": { "resource": "/v1/data/channel", "content_origin": "third_party", "cached": false } }
```

Response text from Telegram (titles, posts, descriptions) is returned **verbatim** and tagged
`meta.content_origin`; treat it as untrusted data, not instructions.

## Environment

| Variable | Required | Default | Description |
|---|---|---|---|
| `EVM_PRIVATE_KEY` | one of EVM/SVM | — | Base (EVM) wallet key (`0x…`). Funds x402 payments. |
| `SVM_PRIVATE_KEY` | one of EVM/SVM | — | Solana wallet secret key (base58). |
| `TELEMOST_BASE_URL` | no | `https://api.telemost.io` | API base URL. |
| `MAX_PAYMENT_USDC` | no | `1` | Per-call price ceiling (USD). A call is refused **before signing** if the price exceeds this. |
| `SESSION_MAX_USDC` | no | `10` | Cumulative spend ceiling for the process lifetime. |
| `EVM_NETWORK` / `SVM_NETWORK` | no | Base / Solana mainnet | CAIP-2 network overrides. |
| `SOLANA_RPC_URL` | no | mainnet-beta | RPC for the Solana signer. |

## Coverage & limits

- **Public** Telegram channels/groups only.
- `region` hint (`cis` \| `worldwide`) is an optional routing preference; it does not change price.
- Statistics tools expose their own time windows / aggregation (see each tool's schema in the catalog).
- Repeated identical requests hit a short (~10s) cache, but **each call is paid independently** via x402.

## Payment & failures

- **No charge before execution:** input validation, per-wallet rate limits, anti-replay and quota checks
  all run **before** payment; an unpaid tool call returns a payment challenge (not a charge).
- **Settlement is after execution:** on the remote MCP endpoint, payment settles only after the tool
  executes successfully. Live delivered-vs-settled reliability is published at
  [`/status`](https://api.telemost.io/status).
- Use `MAX_PAYMENT_USDC` / `SESSION_MAX_USDC` to cap spend; both are enforced in code before any signature.

## Troubleshooting

- **"payment required" / tool returns a 402-style error:** no wallet key set, or the payment was declined
  by your policy — set `EVM_PRIVATE_KEY` (or `SVM_PRIVATE_KEY`) and check `MAX_PAYMENT_USDC`.
- **Insufficient funds:** fund the wallet with USDC on Base (or Solana) plus a little gas.
- **Wrong network:** set `EVM_NETWORK` / `SVM_NETWORK` to a network you funded.
- **`npx` won't launch (Windows):** use the `cmd /c npx …` form above.
- **Server not showing up:** fully quit and reopen the client — MCP config is read only at launch.
- **Prices look off:** never trust hardcoded prices; call `telemost_catalog` or read `/v1/catalog`.

## Funding & safety

- Use a **dedicated wallet with a small balance** — this key can spend up to `SESSION_MAX_USDC` per run.
- The key is read only from the environment and is **never logged**.
- Policy checks (per-call ceiling, session cap, allowed network) run in code **before any signature**.

## Build from source

```bash
git clone https://github.com/slava01011910-ops/telemost-mcp-server.git
cd telemost-mcp-server && npm install && npm run build && node dist/index.js
```

## Support

- Email: **support@telemost.io**
- Listing / proof: [x402scan](https://www.x402scan.com/resources) · Catalog: `https://api.telemost.io/v1/catalog`

## License

MIT
