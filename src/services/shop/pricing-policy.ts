import { AppDataSource } from "../../db/data-source";
import { PlatformSettings } from "../../models/platform-settings";
import { DEFAULT_PRICING_POLICY, PricingPolicy } from "../../config/shop-pricing";
import { DEFAULT_FREIGHT_LIMITS, FreightLimits } from "../../config/shop-freight";

/**
 * The parts of the shelf price we decide rather than the supplier: the duty
 * allowance and the card processor's cut. Admin editable, so they are read
 * from the settings row rather than compiled in.
 *
 * A missing settings row falls back to the defaults instead of pricing on
 * zero fees, because pricing on zero fees is the bug this was written for.
 */
/** The settings row the single, global shop reads its policy from. */
export const SHOP_SETTINGS_COUNTRY = "DEFAULT";

export async function loadPricingPolicy(): Promise<PricingPolicy> {
    const repo = AppDataSource.getRepository(PlatformSettings);
    // There is one shop, but platform_settings has a row per country. The
    // DEFAULT row is the one the shop reads, so the policy does not depend on
    // which row Postgres happens to hand back first.
    const settings =
        (await repo.findOne({ where: { country: SHOP_SETTINGS_COUNTRY } })) ||
        (await repo.findOne({ where: {}, order: { country: "ASC" } }));
    if (!settings) return DEFAULT_PRICING_POLICY;
    const num = (v: unknown, fallback: number) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? n : fallback;
    };
    return {
        dutyRatePct: num(settings.shopDutyRate, DEFAULT_PRICING_POLICY.dutyRatePct),
        processingRatePct: num(settings.shopProcessingFeeRate, DEFAULT_PRICING_POLICY.processingRatePct),
        processingFixedUsd: num(settings.shopProcessingFeeFixed, DEFAULT_PRICING_POLICY.processingFixedUsd),
    };
}

/**
 * The freight we are willing to carry. Admin editable for the same reason
 * the rates are: the right cap is a commercial judgement, not a constant.
 */
export async function loadFreightLimits(): Promise<FreightLimits> {
    const repo = AppDataSource.getRepository(PlatformSettings);
    const settings =
        (await repo.findOne({ where: { country: SHOP_SETTINGS_COUNTRY } })) ||
        (await repo.findOne({ where: {}, order: { country: "ASC" } }));
    if (!settings) return DEFAULT_FREIGHT_LIMITS;
    const num = (v: unknown, fallback: number) => {
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? n : fallback;
    };
    return {
        maxShippingUsd: num(settings.shopMaxShippingUsd, DEFAULT_FREIGHT_LIMITS.maxShippingUsd),
        maxShippingRatio: num(settings.shopMaxShippingRatio, DEFAULT_FREIGHT_LIMITS.maxShippingRatio),
    };
}
