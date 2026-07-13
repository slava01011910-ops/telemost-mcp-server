import { describe, it, expect } from "vitest";
import { checkPolicy, parseAmountUsd, extractAccepts, type Accept } from "../src/policy.js";

const b64 = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString("base64");

// Offline unit tests for the spend-cap policy. No network is touched — checkPolicy only inspects the
// 402 `accepts` array (the payment challenge) and the caller's caps, always BEFORE any signature.

const BASE = "eip155:8453"; // Base mainnet
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const evmOnly = new Set([BASE]);

// helper: an accept entry priced in USDC (6 decimals) on a given network
const at = (network: string, usd: number): Accept => ({ network, maxAmountRequired: String(Math.round(usd * 1e6)) });

describe("extractAccepts (x402 v2: challenge in the payment-required header, body may be empty)", () => {
  const accepts = [{ scheme: "exact", network: BASE, amount: "2100000" }];

  it("reads accepts from the base64 payment-required header (body empty {})", () => {
    const out = extractAccepts(b64({ x402Version: 2, accepts }), {});
    expect(out).toHaveLength(1);
    expect(out[0].network).toBe(BASE);
    expect(out[0].amount).toBe("2100000");
  });

  it("falls back to the JSON body when no header is present", () => {
    expect(extractAccepts(null, { accepts })).toHaveLength(1);
    expect(extractAccepts(undefined, { accepts })[0].amount).toBe("2100000");
  });

  it("prefers the header over the body when both are present", () => {
    const out = extractAccepts(b64({ accepts }), { accepts: [{ network: SOL, amount: "1" }] });
    expect(out[0].network).toBe(BASE);
  });

  it("returns [] for a malformed header and no usable body", () => {
    expect(extractAccepts("!!!not-base64-json!!!", {})).toEqual([]);
    expect(extractAccepts(null, {})).toEqual([]);
    expect(extractAccepts(null, null)).toEqual([]);
  });
});

describe("parseAmountUsd (price parsing from a 402 accept)", () => {
  it("valid maxAmountRequired (base units) → USD", () => {
    expect(parseAmountUsd({ network: BASE, maxAmountRequired: "2100000" })).toBe(2.1);
    expect(parseAmountUsd({ network: BASE, maxAmountRequired: "16500" })).toBe(0.0165);
  });
  it("falls back to `amount` when maxAmountRequired absent", () => {
    expect(parseAmountUsd({ network: BASE, amount: 75000 })).toBe(0.075);
  });
  it("missing amount → NaN (never treated as free)", () => {
    expect(parseAmountUsd({ network: BASE })).toBeNaN();
    expect(parseAmountUsd({ network: BASE, maxAmountRequired: "" })).toBeNaN();
    expect(parseAmountUsd(undefined)).toBeNaN();
  });
  it("garbage / negative amount → NaN", () => {
    expect(parseAmountUsd({ network: BASE, maxAmountRequired: "abc" })).toBeNaN();
    expect(parseAmountUsd({ network: BASE, maxAmountRequired: "-100" })).toBeNaN();
  });
});

describe("checkPolicy — per-call cap (MAX_PAYMENT_USDC)", () => {
  const cfg = { maxPerCallUsd: 1, sessionCapUsd: 10, sessionSpentUsd: 0 };

  it("refuses a call priced above the per-call cap, BEFORE signing", () => {
    const v = checkPolicy([at(BASE, 2.1)], evmOnly, cfg);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toContain("2.1");                 // the call price
      expect(v.reason).toContain("MAX_PAYMENT_USDC=$1"); // the cap value
      expect(v.reason).toContain("Raise MAX_PAYMENT_USDC"); // the env var to raise (actionable)
    }
  });

  it("allows a call at or below the per-call cap and reports the amount", () => {
    const v = checkPolicy([at(BASE, 0.0165)], evmOnly, cfg);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.amountUsd).toBe(0.0165);
  });

  it("default 2.5 cap admits the most expensive catalog tool ($2.10)", () => {
    const v = checkPolicy([at(BASE, 2.1)], evmOnly, { maxPerCallUsd: 2.5, sessionCapUsd: 10, sessionSpentUsd: 0 });
    expect(v.ok).toBe(true);
  });
});

describe("checkPolicy — session cap (SESSION_MAX_USDC)", () => {
  it("accumulates: refuses once the session cap would be exceeded", () => {
    // already spent $9.50, next call $2.10 → 11.60 > 10 → refuse
    const v = checkPolicy([at(BASE, 2.1)], evmOnly, { maxPerCallUsd: 2.5, sessionCapUsd: 10, sessionSpentUsd: 9.5 });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toContain("SESSION_MAX_USDC=$10");
      expect(v.reason).toContain("9.5");                  // already spent
      expect(v.reason).toContain("Raise SESSION_MAX_USDC");
    }
  });

  it("allows when the running total stays within the session cap", () => {
    const v = checkPolicy([at(BASE, 0.0165)], evmOnly, { maxPerCallUsd: 2.5, sessionCapUsd: 10, sessionSpentUsd: 9.5 });
    expect(v.ok).toBe(true);
  });
});

describe("checkPolicy — network & unreadable price", () => {
  const cfg = { maxPerCallUsd: 2.5, sessionCapUsd: 10, sessionSpentUsd: 0 };

  it("refuses when no wallet is held for any offered network (names the env vars)", () => {
    const v = checkPolicy([at(SOL, 0.0165)], evmOnly, cfg); // only Solana offered, EVM-only wallet
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toContain(SOL);
      expect(v.reason).toContain("EVM_PRIVATE_KEY");
      expect(v.reason).toContain("SVM_PRIVATE_KEY");
    }
  });

  it("picks the cheapest affordable network when several are offered", () => {
    const both = new Set([BASE, SOL]);
    const v = checkPolicy([at(BASE, 2.1), at(SOL, 0.05)], both, cfg);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.amountUsd).toBe(0.05);
  });

  it("refuses when the price cannot be read from the challenge (no silent $0)", () => {
    const v = checkPolicy([{ network: BASE, maxAmountRequired: "not-a-number" }], evmOnly, cfg);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("could not read a price");
  });

  it("refuses an empty accepts array", () => {
    expect(checkPolicy([], evmOnly, cfg).ok).toBe(false);
  });
});
