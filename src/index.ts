#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ListPromptsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodTypeAny } from "zod";
import { checkPolicy, extractAccepts } from "./policy.js";

// Keep in sync with package.json "version" (server info version reported to clients/scanners).
const SERVER_VERSION = "0.2.2";

// ── telemost-mcp-server ───────────────────────────────────────────────────────────────────────────
// A stdio MCP bridge to the Telemost x402 HTTP API. Tools are generated at startup from the live
// /openapi.json (single source — no hardcoded tool list). Each paid tool call is paid from the AGENT's
// OWN USDC wallet via x402 over the EXISTING HTTP routes (the prod 402 path is unchanged). Policy checks
// (max amount / allowed network / session cap) run IN CODE before any signature.
//
// IMPORTANT: in stdio mode nothing may be written to stdout except JSON-RPC — all logs go to stderr.
const log = (...a: unknown[]): void => { console.error("[telemost-mcp]", ...a); };

const BASE = (process.env.TELEMOST_BASE_URL ?? "https://api.telemost.io").replace(/\/+$/, "");
// Per-call ceiling (USD). Default 2.5 covers every price in the catalog (max $2.10) so no paid tool is
// dead out of the box; tighten it via the env var if you want a stricter cap.
const MAX_PAYMENT_USDC = Number(process.env.MAX_PAYMENT_USDC ?? 2.5);
const SESSION_MAX_USDC = Number(process.env.SESSION_MAX_USDC ?? 10);      // cumulative session ceiling (USD)
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";

let sessionSpent = 0;

// ── Build the buyer x402 client from the agent's wallet key(s) ──
async function buildBuyer(): Promise<{ client: unknown; networks: Set<string> }> {
  const { x402Client } = await import("@x402/fetch");
  const client = new x402Client();
  const networks = new Set<string>();
  const evmKey = process.env.EVM_PRIVATE_KEY;
  const svmKey = process.env.SVM_PRIVATE_KEY;
  if (evmKey) {
    const { privateKeyToAccount } = await import("viem/accounts");
    const { ExactEvmScheme } = await import("@x402/evm/exact/client");
    const net = (process.env.EVM_NETWORK ?? "eip155:8453") as `${string}:${string}`; // Base mainnet
    client.register(net, new ExactEvmScheme(privateKeyToAccount(evmKey as `0x${string}`)));
    networks.add(net);
    log(`EVM wallet loaded for ${net}`);
  }
  if (svmKey) {
    const { createKeyPairSignerFromBytes } = await import("@solana/kit");
    const { ExactSvmScheme } = await import("@x402/svm/exact/client");
    const bs58 = (await import("bs58")).default;
    const net = (process.env.SVM_NETWORK ?? "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp") as `${string}:${string}`; // Solana mainnet
    const signer = await createKeyPairSignerFromBytes(bs58.decode(svmKey));
    client.register(net, new ExactSvmScheme(signer, { rpcUrl: SOLANA_RPC_URL }));
    networks.add(net);
    log(`SVM wallet loaded for ${net}`);
  }
  if (networks.size === 0) log("WARNING: no wallet key set (EVM_PRIVATE_KEY / SVM_PRIVATE_KEY) — paid tools will fail.");
  return { client, networks };
}

// ── Minimal JSON-Schema → Zod (same shapes the API publishes) ──
function propToZod(prop: Record<string, unknown>): ZodTypeAny {
  const type = prop.type as string | undefined;
  if (Array.isArray(prop.enum) && prop.enum.every((v) => typeof v === "string")) return z.enum(prop.enum as [string, ...string[]]);
  if (type === "string") return z.string();
  if (type === "integer") return z.number().int();
  if (type === "number") return z.number();
  if (type === "boolean") return z.boolean();
  if (type === "array") return z.array(z.string());
  if (type === "object") return z.object({}).passthrough();
  return z.unknown();
}
function inputShape(schema: Record<string, unknown>): Record<string, ZodTypeAny> {
  const props = (schema.properties as Record<string, Record<string, unknown>>) ?? {};
  const required = new Set((schema.required as string[]) ?? []);
  const shape: Record<string, ZodTypeAny> = {};
  for (const [name, p] of Object.entries(props)) {
    const zt = propToZod(p);
    shape[name] = required.has(name) ? zt : zt.optional();
  }
  return shape;
}

interface OpenApiOp { path: string; method: "get" | "post"; operationId: string; summary?: string; inputSchema: Record<string, unknown> }

// Read the live OpenAPI and derive one operation per paid endpoint (operationId = registry id).
async function fetchOperations(): Promise<OpenApiOp[]> {
  const res = await fetch(`${BASE}/openapi.json`);
  if (!res.ok) throw new Error(`GET /openapi.json → ${res.status}`);
  const spec = (await res.json()) as { paths: Record<string, Record<string, Record<string, unknown>>> };
  const ops: OpenApiOp[] = [];
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const method of ["get", "post"] as const) {
      const op = methods[method];
      if (!op) continue;
      const operationId = String(op.operationId ?? "");
      if (!operationId || operationId === "catalog" || operationId === "discovery") continue; // free/alias handled separately
      // GET → parameters[]; POST → requestBody schema.
      let inputSchema: Record<string, unknown> = { type: "object", properties: {}, required: [] };
      if (method === "get" && Array.isArray(op.parameters)) {
        const properties: Record<string, unknown> = {};
        const required: string[] = [];
        for (const p of op.parameters as Array<Record<string, unknown>>) {
          properties[p.name as string] = p.schema;
          if (p.required) required.push(p.name as string);
        }
        inputSchema = { type: "object", properties, required };
      } else if (method === "post") {
        const rb = op.requestBody as { content?: Record<string, { schema?: Record<string, unknown> }> } | undefined;
        inputSchema = rb?.content?.["application/json"]?.schema ?? inputSchema;
      }
      ops.push({ path, method, operationId, summary: op.summary as string | undefined, inputSchema });
    }
  }
  return ops;
}

function buildUrl(op: OpenApiOp, args: Record<string, unknown>): { url: string; init: RequestInit } {
  if (op.method === "get") {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(args)) if (v != null) qs.append(k, String(v));
    const q = qs.toString();
    return { url: `${BASE}${op.path}${q ? "?" + q : ""}`, init: { method: "GET" } };
  }
  return { url: `${BASE}${op.path}`, init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(args) } };
}

const okResult = (obj: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj) }], structuredContent: obj as Record<string, unknown> });
const errResult = (message: string) => ({ content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: { message } }) }], isError: true });

async function main(): Promise<void> {
  const { client, networks } = await buildBuyer();
  const { wrapFetchWithPayment } = await import("@x402/fetch");
  const payFetch = wrapFetchWithPayment(fetch, client as never);
  const ops = await fetchOperations();
  log(`loaded ${ops.length} paid tools from ${BASE}/openapi.json`);

  const mcp = new McpServer({ name: "telemost-mcp-server", version: SERVER_VERSION });

  // Free catalog tool.
  mcp.registerTool("telemost_catalog", {
    title: "telemost_catalog",
    description: "Free machine-readable catalog of all paid Telemost tools (prices, schemas, examples). No payment.",
    inputSchema: z.object({ block: z.enum(["data", "statistics", "ads", "reference"]).optional() }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: true },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any, (async (args: { block?: string }) => {
    const url = `${BASE}/v1/catalog${args?.block ? `?block=${encodeURIComponent(args.block)}` : ""}`;
    const res = await fetch(url);
    return okResult(await res.json());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any);

  // Paid tools.
  for (const op of ops) {
    mcp.registerTool(`telemost_${op.operationId}`, {
      title: `telemost_${op.operationId}`,
      description: `${op.summary ?? op.operationId} Paid per call in USDC from your wallet (see telemost_catalog for the price).`,
      inputSchema: z.object(inputShape(op.inputSchema)).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: op.method === "get", openWorldHint: true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any, (async (args: Record<string, unknown>) => {
      try {
        const { url, init } = buildUrl(op, args ?? {});
        // Preflight (free 402) → policy check BEFORE signing.
        const probe = await fetch(url, init);
        if (probe.status === 402) {
          // x402 v2 returns the challenge in the `payment-required` header (base64 JSON); body may be {}.
          const body = await probe.json().catch(() => ({}));
          const accepts = extractAccepts(probe.headers.get("payment-required"), body);
          const verdict = checkPolicy(accepts, networks, {
            maxPerCallUsd: MAX_PAYMENT_USDC,
            sessionCapUsd: SESSION_MAX_USDC,
            sessionSpentUsd: sessionSpent,
          });
          if (!verdict.ok) return errResult(`payment policy blocked this call: ${verdict.reason}`);
          const paid = await payFetch(url, init);
          if (!paid.ok && paid.status !== 200) return errResult(`paid request failed (HTTP ${paid.status})`);
          sessionSpent += verdict.amountUsd;
          log(`paid $${verdict.amountUsd} for ${op.operationId} (session $${sessionSpent.toFixed(4)})`);
          return okResult(await paid.json());
        }
        // 200 (e.g. free/edge) or other → return as-is.
        return okResult(await probe.json());
      } catch (e) {
        return errResult(`tool call failed: ${(e as Error).message}`);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);
  }

  // Empty resources/prompts so clients/scanners get [] on resources/list & prompts/list, not -32601.
  mcp.server.registerCapabilities({ resources: {}, prompts: {} });
  mcp.server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: [] }));
  mcp.server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({ resourceTemplates: [] }));
  mcp.server.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts: [] }));

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  log("ready (stdio)");
}

main().catch((e) => { log("fatal:", (e as Error).message); process.exit(1); });
