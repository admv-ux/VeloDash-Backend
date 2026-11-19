/**
 * Retail pricing for Zendrop catalogue items.
 *
 * Zendrop quotes a wholesale price and charges shipping separately, and we pay
 * both in USD once an order is fulfilled. The retail price therefore has to
 * cover landed cost plus margin, which is where the multiplier comes in. There
 * is deliberately no 15% platform delivery commission on shopping orders: the
 * multiplier IS the margin, and charging both would price us out.
 */

/**
 * Markup by landed cost. The boundaries are inclusive at the top of the middle
 * band, so a cost of exactly 15 or exactly 35 takes 1.8.
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
    wholesale: number;
    shipping: number;
    cost: number;
    multiplier: number;
    retail: number;
    margin: number;
}

/**
 * Landed cost to shelf price. `shipping` is the US shipping quote, which is the
 * reference market for the markup even when the buyer is elsewhere.
 */
export function retailPriceFor(wholesale: number, shipping: number): RetailPrice {
    const w = Number(wholesale) || 0;
    const s = Number(shipping) || 0;
    const cost = Math.round((w + s) * 100) / 100;
    const multiplier = multiplierForCost(cost);
    const retail = roundUpTo99(cost * multiplier);
    return {
        wholesale: w,
        shipping: s,
        cost,
        multiplier,
        retail,
        margin: Math.round((retail - cost) * 100) / 100,
    };
}
