// Cost computation from usage counters + pricing tables. Pure.
//
// Rates are resolved against the SERVER-reported model id (dated snapshot,
// e.g. claude-haiku-4-5-20251001): exact key first, then the id with its
// trailing -YYYYMMDD date stripped. Unknown model → null (never guess a
// price).

import type { ModelPricing } from "../config.js";
import type { UsageInfo } from "../transport/anthropic.js";

export function resolveRates(
  model: string | null,
  pricing: Record<string, ModelPricing>,
): ModelPricing | null {
  if (!model) return null;
  const exact = pricing[model];
  if (exact) return exact;
  const undated = model.replace(/-\d{8}$/, "");
  if (undated !== model && pricing[undated]) return pricing[undated];
  return null;
}

// Cache reads bill at cacheInputPerMTok (fallback: full input rate —
// conservative, never underestimates). Cache writes at cacheWritePerMTok
// (same fallback).
export function computeCostUsd(usage: UsageInfo, rates: ModelPricing): number {
  const per = (tokens: number | undefined, ratePerMTok: number): number =>
    ((tokens ?? 0) * ratePerMTok) / 1_000_000;
  return (
    per(usage.input_tokens, rates.inputPerMTok) +
    per(usage.output_tokens, rates.outputPerMTok) +
    per(
      usage.cache_read_input_tokens,
      rates.cacheInputPerMTok ?? rates.inputPerMTok,
    ) +
    per(
      usage.cache_creation_input_tokens,
      rates.cacheWritePerMTok ?? rates.inputPerMTok,
    )
  );
}

export function formatUsd(cost: number): string {
  return `$${cost.toFixed(cost < 0.1 ? 4 : 2)}`;
}
