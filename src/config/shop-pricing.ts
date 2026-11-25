/**
 * Retail pricing for Zendrop catalogue items.
 *
 * Every cost of selling one unit has to be inside the shelf price, because
 * the shopper is charged one number and shipping is not billed on top in the
 * baseline market. The shape of it:
 *
 *   selling price = (product + shipping + duties + card fees) x multiplier
 *
 * Product and shipping are what Zendrop bills us. Duties are a percentage we
 * set aside, since customs is charged on the landed value and not every lane
 * is duty free. Card fees are what the processor keeps out of the money the
 * shopper pays, which is a real cost of the sale and used to be ignored.
 *
 * There is deliberately no 15% platform delivery commission on shopping
 * orders: the multiplier IS the margin, and charging both would price us out.
 */

/**
 * The parts of the price that are policy rather than supplier data, so the
 * admin can move them without a deploy. Percentages, not fractions.
 */
export interface PricingPolicy {
    /** Customs and import duties, as a percent of the landed value. */
    dutyRatePct: number;
    /** What the card processor keeps, as a percent of the selling price. */
    processingRatePct: number;
    /** What the card processor keeps per transaction, flat, in USD. */
    processingFixedUsd: number;
}

/**
 * Used when the settings row has not been read, and the default for a fresh
 * install.
 *
 * 4.4% + $0.30 is Stripe's 2.9% + 30c domestic card rate plus the 1.5% they
 * add for an international card. A shop that ships to 27 countries takes
 * foreign cards most of the time, so pricing on the domestic rate would
 * quietly under-recover on the majority of orders. Currency conversion costs
 * another 1% when it happens, which is not assumed here.
 *
 * Duties default to zero: Zendrop ships most lanes with duties payable by the
 * recipient, so setting aside a margin for them would raise every price for a
 * cost we do not usually carry. Set it in the admin if that changes.
 */
export const DEFAULT_PRICING_POLICY: PricingPolicy = {
    dutyRatePct: 0,
    processingRatePct: 4.4,
    processingFixedUsd: 0.3,
};

/**
 * Markup by supplier cost. The boundaries are inclusive at the top of the
 * middle band, so a cost of exactly 15 or exactly 35 takes 1.8.
 *
 * Read on product + shipping + duties, before card fees. The fee depends on
 * the selling price, and the selling price depends on the multiplier, so
 * choosing the band on the fee as well would make the band chase itself near
 * a boundary and flip on rounding noise.
 */
export function multiplierForCost(cost: number): number {
    if (cost < 15) return 2.2;
    if (cost <= 35) return 1.8;
    return 1.5;
}

/**
 * Round UP to the next price ending in .99.
 *
 * 26.40 -> 26.99, 39.01 -> 39.99, and an exact 26.99 stays put. Always up, so
 * rounding can never push a price below landed cost.
 */
export function roundUpTo99(amount: number): number {
    if (!Number.isFinite(amount) || amount <= 0) return 0.99;
    // ceil, not round: this must never resolve downward. The epsilon absorbs
    // float noise, since 39.995 * 100 is really 3999.4999999999995 and a plain
    // round would read that as 39.99 and sell half a cent under.
    const cents = Math.ceil(amount * 100 - 1e-9);
    const whole = Math.floor(cents / 100);
    const target = whole * 100 + 99;
    return (cents <= target ? target : target + 100) / 100;
}

export interface RetailPrice {
    /** What Zendrop charges for the goods. */
    wholesale: number;
    /** Zendrop's shipping quote for the baseline market. */
    shipping: number;
    /** Set aside for customs and import duties. */
    duty: number;
    /** What the card processor keeps out of this sale. */
    processing: number;
    /**
     * Everything one sale costs us: goods, shipping, duties and card fees.
     * This is the number a margin is measured against.
     */
    cost: number;
    /** Supplier cost before card fees, which is what picks the band. */
    supplierCost: number;
    multiplier: number;
    retail: number;
    /** retail - cost. What the sale actually leaves. */
    margin: number;
}

const money = (n: number) => Math.round(n * 100) / 100;

/**
 * Landed cost to shelf price.
 *
 * `shipping` is the US shipping quote, which is the reference market for the
 * markup even when the buyer is elsewhere; a dearer destination pays the
 * difference at checkout.
 *
 * The card fee is a percentage of the selling price, and the selling price is
 * built from the card fee, so the two are solved together rather than
 * guessed:
 *
 *   retail = m x (base + fixed + rate x retail)
 *   retail = m x (base + fixed) / (1 - m x rate)
 *
 * Without that step a fee added before the multiplier under-recovers, because
 * the multiplier pushes the price up and the processor takes a percentage of
 * the higher number.
 */
export function retailPriceFor(
    wholesale: number,
    shipping: number,
    policy: PricingPolicy = DEFAULT_PRICING_POLICY,
): RetailPrice {
    const w = Math.max(0, Number(wholesale) || 0);
    const s = Math.max(0, Number(shipping) || 0);

    const dutyRate = Math.max(0, Number(policy.dutyRatePct) || 0) / 100;
    const feeRate = Math.max(0, Number(policy.processingRatePct) || 0) / 100;
    const feeFixed = Math.max(0, Number(policy.processingFixedUsd) || 0);

    // Customs values a parcel on goods plus freight, so duty is taken on both.
    const duty = money((w + s) * dutyRate);
    const supplierCost = money(w + s + duty);
    const multiplier = multiplierForCost(supplierCost);

    // A fee rate at or above 1/multiplier has no solution: the processor would
    // take more than the markup adds. Treat it as a misconfiguration and price
    // without the percentage rather than return a negative or absurd number.
    const denominator = 1 - multiplier * feeRate;
    const retail = denominator > 0.05
        ? roundUpTo99((multiplier * (supplierCost + feeFixed)) / denominator)
        : roundUpTo99(multiplier * (supplierCost + feeFixed));

    // On the final price, which is what the processor actually takes.
    const processing = money(retail * feeRate + feeFixed);
    const cost = money(supplierCost + processing);

    return {
        wholesale: w,
        shipping: s,
        duty,
        processing,
        cost,
        supplierCost,
        multiplier,
        retail,
        margin: money(retail - cost),
    };
}
