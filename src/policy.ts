// Spend-cap policy for the stdio bridge. Pure, side-effect-free, network-free — unit-tested in
// tests/policy.test.ts. The refusal always happens BEFORE any signature: an unpaid tool call returns
// a payment challenge (402 `accepts`); we read the price from it and compare against the caller's caps.

export const USDC_DECIMALS = 6;

export interface Accept {
  network?: string;
  maxAmountRequired?: string | number;
  amount?: string | number;
}

export interface PolicyConfig {
  maxPerCallUsd: number;   // MAX_PAYMENT_USDC
  sessionCapUsd: number;   // SESSION_MAX_USDC
  sessionSpentUsd: number; // cumulative spend so far this process
}

export type PolicyVerdict = { ok: true; amountUsd: number } | { ok: false; reason: string };

// The x402 v2 payment challenge is returned in the `payment-required` response header as base64-encoded
// JSON (the response body may be empty `{}`). Some servers instead place the same object in the JSON body.
// Read the header first, fall back to the body. Returns [] if neither carries an `accepts` array.
export function extractAccepts(paymentRequiredHeader: string | null | undefined, body: unknown): Accept[] {
  if (paymentRequiredHeader) {
    try {
      const decoded = Buffer.from(paymentRequiredHeader, "base64").toString("utf8");
      const json = JSON.parse(decoded) as { accepts?: unknown };
      if (Array.isArray(json.accepts)) return json.accepts as Accept[];
    } catch {
      /* malformed header — fall through to the body */
    }
  }
  const b = body as { accepts?: unknown } | null | undefined;
  if (b && Array.isArray(b.accepts)) return b.accepts as Accept[];
  return [];
}

// Trim to at most 6 decimals without forcing trailing zeros (e.g. 2.1, 1, 8.5).
function fmt(n: number): string {
  return String(Math.round(n * 10 ** USDC_DECIMALS) / 10 ** USDC_DECIMALS);
}

// Parse one 402 `accepts` entry to a USD price. Returns NaN for a missing/garbage amount — the caller
// must treat NaN as "price unknown" and REFUSE (never sign a payment for an amount we could not read).
export function parseAmountUsd(a: Accept | undefined | null): number {
  const raw = a?.maxAmountRequired ?? a?.amount;
  if (raw === undefined || raw === null || raw === "") return NaN;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) return NaN;
  return n / 10 ** USDC_DECIMALS;
}

// Decide whether a call may be paid: a wallet for an offered network, a readable price, price within the
// per-call cap, and the session cap not exceeded. Every refusal reason is actionable (names the price,
// the cap value, and the env var to raise).
export function checkPolicy(
  accepts: Accept[] | undefined | null,
  allowedNetworks: Set<string>,
  cfg: PolicyConfig,
): PolicyVerdict {
  const offered = accepts ?? [];
  const affordable = offered.filter((a) => a?.network && allowedNetworks.has(String(a.network)));
  if (affordable.length === 0) {
    const nets = offered.map((a) => a?.network).filter(Boolean).join(", ") || "none";
    return { ok: false, reason: `no wallet configured for any offered network (${nets}). Set EVM_PRIVATE_KEY or SVM_PRIVATE_KEY for a supported network.` };
  }
  const prices = affordable.map(parseAmountUsd).filter((p) => !Number.isNaN(p));
  if (prices.length === 0) {
    return { ok: false, reason: "could not read a price from the payment challenge; refused before signing." };
  }
  const minUsd = Math.min(...prices);
  if (minUsd > cfg.maxPerCallUsd) {
    return { ok: false, reason: `call costs $${fmt(minUsd)}, exceeds MAX_PAYMENT_USDC=$${fmt(cfg.maxPerCallUsd)}. Raise MAX_PAYMENT_USDC to allow this call.` };
  }
  if (cfg.sessionSpentUsd + minUsd > cfg.sessionCapUsd) {
    return { ok: false, reason: `call costs $${fmt(minUsd)}; SESSION_MAX_USDC=$${fmt(cfg.sessionCapUsd)} would be exceeded (already spent $${fmt(cfg.sessionSpentUsd)} this session). Raise SESSION_MAX_USDC to allow.` };
  }
  return { ok: true, amountUsd: minUsd };
}
