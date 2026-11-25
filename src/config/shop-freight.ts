/**
 * When shipping costs too much for a product to be worth listing.
 *
 * Zendrop quotes freight per product, and for anything bulky coming out of
 * China that quote can dwarf the goods. A gaming chair with a 36.27 wholesale
 * came back at 1,010.88 to ship, which priced it at 1,850.99. The maths was
 * right and the listing was absurd, and a catalogue with a few of those in it
 * does not look like a shop anyone should buy from.
 *
 * Two limits, because one does not catch both shapes of the problem:
 *
 *  - An absolute cap. Freight above it is furniture and gym equipment, which
 *    is not a category a dropshipper wins at. Thirty products sat above 50
 *    dollars, and the next one down paid 47.65, so the tail is clearly
 *    separate from the rest of the catalogue.
 *
 *  - A ratio. An 89 cent corkscrew with 25.56 of shipping is 57.99 on the
 *    shelf, well under the cap and still ridiculous. Once freight is several
 *    times the goods, the shopper is paying for a courier, not a product.
 *
 * The ratio is only applied above a floor, so an ordinary cheap parcel is left
 * alone: a 2.23 dog scarf with 5.32 of shipping sells perfectly well at 20.99
 * and would otherwise be caught by a ratio of four.
 */

export interface FreightLimits {
    /** Most we will carry in freight on one unit, in USD. */
    maxShippingUsd: number;
    /** Most the freight may be as a multiple of the goods, above the floor. */
    maxShippingRatio: number;
}

export const DEFAULT_FREIGHT_LIMITS: FreightLimits = {
    maxShippingUsd: 50,
    maxShippingRatio: 4,
};

/**
 * Below this, freight is just postage and the ratio is not worth applying.
 * Never above the cap itself, so lowering the cap cannot leave a gap where
 * nothing is checked.
 */
const RATIO_FLOOR_USD = 20;

const usd = (n: number) => n.toFixed(2);

/** The reason this product should not be listed, or null if it is fine. */
export function freightProblem(
    wholesale: number,
    shipping: number,
    limits: FreightLimits = DEFAULT_FREIGHT_LIMITS,
): string | null {
    const w = Math.max(0, Number(wholesale) || 0);
    const s = Math.max(0, Number(shipping) || 0);
    const cap = Number(limits.maxShippingUsd) > 0 ? Number(limits.maxShippingUsd) : Infinity;
    const ratio = Number(limits.maxShippingRatio) > 0 ? Number(limits.maxShippingRatio) : Infinity;

    if (s > cap) return `Shipping is ${usd(s)}, over the ${cap.toFixed(0)} limit`;

    const floor = Math.min(RATIO_FLOOR_USD, cap);
    if (s > floor && w > 0 && s > w * ratio) {
        return `Shipping is ${usd(s)} on a ${usd(w)} product`;
    }
    return null;
}
