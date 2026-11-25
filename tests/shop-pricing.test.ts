import {
    multiplierForCost,
    roundUpTo99,
    retailPriceFor,
    DEFAULT_PRICING_POLICY,
    PricingPolicy,
} from "../src/config/shop-pricing";

/** The old model: supplier cost only, no duties and no card fee. */
const NO_FEES: PricingPolicy = { dutyRatePct: 0, processingRatePct: 0, processingFixedUsd: 0 };

/**
 * These pin the money. A wrong multiplier or a rounding step that goes DOWN
 * sells Zendrop stock below landed cost, and we only find out at settlement.
 */

describe("multiplierForCost", () => {
    it("charges 2.2x below 15", () => {
        expect(multiplierForCost(0)).toBe(2.2);
        expect(multiplierForCost(14.99)).toBe(2.2);
    });

    it("charges 1.8x from 15 through 35 inclusive", () => {
        expect(multiplierForCost(15)).toBe(1.8);
        expect(multiplierForCost(25)).toBe(1.8);
        expect(multiplierForCost(35)).toBe(1.8);
    });

    it("charges 1.5x above 35", () => {
        expect(multiplierForCost(35.01)).toBe(1.5);
        expect(multiplierForCost(500)).toBe(1.5);
    });
});

describe("roundUpTo99", () => {
    it("matches the worked example from the brief", () => {
        expect(roundUpTo99(26.40)).toBe(26.99);
    });

    it("always rounds up, never down", () => {
        expect(roundUpTo99(39.01)).toBe(39.99);
        expect(roundUpTo99(39.98)).toBe(39.99);
        expect(roundUpTo99(10.00)).toBe(10.99);
    });

    it("leaves a price that already ends in .99 alone", () => {
        expect(roundUpTo99(26.99)).toBe(26.99);
    });

    it("carries into the next dollar when it has to", () => {
        // 39.995 rounds to 40.00 cents-wise, which is past 39.99.
        expect(roundUpTo99(39.995)).toBe(40.99);
    });

    it("never returns zero or a negative price", () => {
        expect(roundUpTo99(0)).toBe(0.99);
        expect(roundUpTo99(-5)).toBe(0.99);
        expect(roundUpTo99(NaN)).toBe(0.99);
    });
});

describe("retailPriceFor", () => {
    it("prices the real catalogue item we probed", () => {
        // Product 2693395: wholesale 7.99, US shipping 13.68 -> cost 21.67,
        // middle band, 21.67 * 1.8 = 39.006 -> 39.99.
        const p = retailPriceFor(7.99, 13.68, NO_FEES);
        expect(p.cost).toBe(21.67);
        expect(p.multiplier).toBe(1.8);
        expect(p.retail).toBe(39.99);
        expect(p.margin).toBe(18.32);
    });

    it("uses the high multiple on a cheap light item", () => {
        const p = retailPriceFor(3.00, 4.50, NO_FEES);
        expect(p.cost).toBe(7.5);
        expect(p.multiplier).toBe(2.2);
        expect(p.retail).toBe(16.99); // 16.50 -> 16.99
    });

    it("uses the low multiple on an expensive item", () => {
        const p = retailPriceFor(60, 20, NO_FEES);
        expect(p.cost).toBe(80);
        expect(p.multiplier).toBe(1.5);
        expect(p.retail).toBe(120.99);
    });

    it("never prices below landed cost", () => {
        for (let w = 0.5; w < 120; w += 0.37) {
            for (const s of [0, 2.5, 13.68, 40]) {
                const p = retailPriceFor(w, s);
                expect(p.retail).toBeGreaterThan(p.cost);
                expect(p.margin).toBeGreaterThan(0);
            }
        }
    });

    it("always ends in .99", () => {
        for (let w = 1; w < 200; w += 1.7) {
            const p = retailPriceFor(w, 6.25);
            expect(Math.round(p.retail * 100) % 100).toBe(99);
        }
    });

    it("treats missing shipping as zero rather than NaN", () => {
        const p = retailPriceFor(10, undefined as any, NO_FEES);
        expect(p.cost).toBe(10);
        expect(p.retail).toBe(22.99);
    });
});

/**
 * The costs the first model left out.
 *
 * Retail used to be (goods + shipping) x multiplier, with nothing set aside
 * for the card processor and nothing for customs. The processor takes its
 * cut out of every sale whether or not the price accounts for it, so the
 * price now accounts for it: the shelf price is solved for, rather than the
 * fee being bolted on before the multiplier where the markup then inflates
 * it and the processor takes a percentage of the bigger number anyway.
 */
describe("card fees and duties are inside the price", () => {
    it("prices the commuter bag the owner asked about", () => {
        // Zendrop: goods 2.65, US shipping 6.34. The admin table called the
        // 8.99 total "Cost", which read as the product price with shipping
        // still to come. It was never that: shipping was already in it.
        const p = retailPriceFor(2.65, 6.34);
        expect(p.supplierCost).toBe(8.99);
        expect(p.multiplier).toBe(2.2);
        expect(p.retail).toBe(22.99);
        // 4.4% of 22.99 plus 30c.
        expect(p.processing).toBe(1.31);
        expect(p.cost).toBe(10.3);
        expect(p.margin).toBe(12.69);
    });

    it("leaves more than the old model did, not less", () => {
        const now = retailPriceFor(2.65, 6.34);
        const before = retailPriceFor(2.65, 6.34, NO_FEES);
        // The old price was 19.99 and the fee came out of the margin unseen.
        expect(before.retail).toBe(19.99);
        expect(now.retail).toBeGreaterThan(before.retail);
        expect(now.margin).toBeGreaterThan(before.retail - before.cost - (19.99 * 0.044 + 0.3));
    });

    it("recovers the fee rather than under-recovering it", () => {
        // The point of solving for the price: at the final price, the margin
        // is still at least (multiplier - 1) x supplier cost, which is what
        // the multiplier is for. Bolting the fee on beforehand fails this.
        for (const [w, s] of [[2.65, 6.34], [7.99, 13.68], [40, 20], [0.5, 1]] as const) {
            const p = retailPriceFor(w, s);
            expect(p.margin).toBeGreaterThanOrEqual((p.multiplier - 1) * p.supplierCost - 0.01);
        }
    });

    it("takes duty on goods and freight together, at the admin's rate", () => {
        const p = retailPriceFor(10, 10, { ...DEFAULT_PRICING_POLICY, dutyRatePct: 12 });
        expect(p.duty).toBe(2.4);
        expect(p.supplierCost).toBe(22.4);
        // 22.40 lands in the middle band, where the old 20.00 did not.
        expect(p.multiplier).toBe(1.8);
    });

    it("charges nothing for duty when the rate is zero", () => {
        expect(retailPriceFor(10, 10).duty).toBe(0);
    });

    it("never sells under the true cost of the sale, at any rate", () => {
        const policies: PricingPolicy[] = [
            DEFAULT_PRICING_POLICY,
            NO_FEES,
            { dutyRatePct: 25, processingRatePct: 6, processingFixedUsd: 0.5 },
            { dutyRatePct: 0, processingRatePct: 12, processingFixedUsd: 1 },
        ];
        for (const policy of policies) {
            for (let w = 0.5; w < 120; w += 3.7) {
                for (const s of [0, 2.5, 13.68, 40]) {
                    const p = retailPriceFor(w, s, policy);
                    expect(p.retail).toBeGreaterThan(p.cost);
                    expect(p.margin).toBeGreaterThan(0);
                }
            }
        }
    });

    it("still prices sanely if someone sets a fee the markup cannot carry", () => {
        // 50% of the sale at a 2.2x markup has no solution. It must not
        // return a negative or a wild number; it prices without the
        // percentage and the margin check below still holds.
        const p = retailPriceFor(5, 5, { dutyRatePct: 0, processingRatePct: 50, processingFixedUsd: 0 });
        expect(Number.isFinite(p.retail)).toBe(true);
        expect(p.retail).toBeGreaterThan(0);
        expect(p.retail).toBeLessThan(100);
    });

    it("ignores a negative rate instead of paying it out", () => {
        const p = retailPriceFor(10, 5, { dutyRatePct: -10, processingRatePct: -5, processingFixedUsd: -1 });
        expect(p.duty).toBe(0);
        expect(p.processing).toBe(0);
        expect(p.cost).toBe(15);
    });

    it("keeps every price ending in .99", () => {
        for (let w = 1; w < 200; w += 1.7) {
            expect(Math.round(retailPriceFor(w, 6.25).retail * 100) % 100).toBe(99);
        }
    });

    it("defaults to Stripe's international card rate, not the domestic one", () => {
        expect(DEFAULT_PRICING_POLICY.processingRatePct).toBe(4.4);
        expect(DEFAULT_PRICING_POLICY.processingFixedUsd).toBe(0.3);
        expect(DEFAULT_PRICING_POLICY.dutyRatePct).toBe(0);
    });
});
