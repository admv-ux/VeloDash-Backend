import {
    multiplierForCost,
    roundUpTo99,
    retailPriceFor,
} from "../src/config/shop-pricing";

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
        const p = retailPriceFor(7.99, 13.68);
        expect(p.cost).toBe(21.67);
        expect(p.multiplier).toBe(1.8);
        expect(p.retail).toBe(39.99);
        expect(p.margin).toBe(18.32);
    });

    it("uses the high multiple on a cheap light item", () => {
        const p = retailPriceFor(3.00, 4.50);
        expect(p.cost).toBe(7.5);
        expect(p.multiplier).toBe(2.2);
        expect(p.retail).toBe(16.99); // 16.50 -> 16.99
    });

    it("uses the low multiple on an expensive item", () => {
        const p = retailPriceFor(60, 20);
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
        const p = retailPriceFor(10, undefined as any);
        expect(p.cost).toBe(10);
        expect(p.retail).toBe(22.99);
    });
});
