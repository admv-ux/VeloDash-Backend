import { AppDataSource } from "../src/db/data-source";
import { ShopRepriceService } from "../src/services/shop/reprice-service";
import { retailPriceFor, DEFAULT_PRICING_POLICY } from "../src/config/shop-pricing";

/**
 * Repricing is how a rate change reaches the shop. Prices are stored on the
 * rows, so until this runs the admin can edit a number and nothing moves.
 *
 * Two things it must never get wrong: the price on the grid and the price on
 * the variant have to move together, since the grid lists the cheapest
 * variant and the basket charges the variant; and it must not rewrite rows
 * that have not changed, because every write is a row the next sync has to
 * reconcile.
 */

function harness(rows: any[], policy = DEFAULT_PRICING_POLICY) {
    const saved: any[] = [];
    const repo = {
        find: async () => rows,
        save: async (r: any) => { saved.push(r); return r; },
    };
    const settings = {
        findOne: async () => ({
            country: "DEFAULT",
            shopDutyRate: policy.dutyRatePct,
            shopProcessingFeeRate: policy.processingRatePct,
            shopProcessingFeeFixed: policy.processingFixedUsd,
        }),
    };
    const original = (AppDataSource as any).getRepository;
    (AppDataSource as any).getRepository = (entity: any) =>
        entity?.name === "PlatformSettings" ? settings : repo;

    const svc = new ShopRepriceService();
    (svc as any).productRepo = repo;
    return { svc, saved, restore: () => { (AppDataSource as any).getRepository = original; } };
}

const product = (over: Record<string, any> = {}) => ({
    id: "p1",
    wholesalePrice: 2.65,
    shippingCost: 6.34,
    retailPrice: 19.99,
    multiplier: 2.2,
    landedCost: 8.99,
    dutyCost: 0,
    processingFee: 0,
    variants: [
        { sku: "A", title: "One", storeVariantId: "1", zendropVariantId: 1, wholesale: 2.65, landedCost: 8.99, retail: 19.99, image: null, inStock: true },
    ],
    ...over,
});

describe("repricing the catalogue", () => {
    it("raises the price that did not cover the card fee, and records the parts", async () => {
        const h = harness([product()]);
        try {
            const out = await h.svc.repriceAll();
            expect(out).toMatchObject({ examined: 1, changed: 1, raised: 1, lowered: 0 });
            const row = h.saved[0];
            expect(row.retailPrice).toBe(22.99);
            expect(row.processingFee).toBe(1.31);
            expect(row.dutyCost).toBe(0);
            expect(row.landedCost).toBe(10.3);
            expect(row.multiplier).toBe(2.2);
        } finally {
            h.restore();
        }
    });

    it("moves the variant price with the product price", async () => {
        const h = harness([product()]);
        try {
            await h.svc.repriceAll();
            const row = h.saved[0];
            expect(row.variants[0].retail).toBe(row.retailPrice);
            expect(row.variants[0].landedCost).toBe(row.landedCost);
            // Everything else about the variant survives.
            expect(row.variants[0]).toMatchObject({ sku: "A", storeVariantId: "1", inStock: true });
        } finally {
            h.restore();
        }
    });

    it("prices each variant from its own wholesale, not the product's", async () => {
        const row = product({
            variants: [
                { sku: "A", title: "Small", storeVariantId: "1", zendropVariantId: 1, wholesale: 2.65, landedCost: 0, retail: 0, image: null, inStock: true },
                { sku: "B", title: "Large", storeVariantId: "2", zendropVariantId: 2, wholesale: 9.0, landedCost: 0, retail: 0, image: null, inStock: true },
            ],
        });
        const h = harness([row]);
        try {
            await h.svc.repriceAll();
            const v = h.saved[0].variants;
            expect(v[0].retail).toBe(retailPriceFor(2.65, 6.34).retail);
            expect(v[1].retail).toBe(retailPriceFor(9.0, 6.34).retail);
            expect(v[1].retail).toBeGreaterThan(v[0].retail);
        } finally {
            h.restore();
        }
    });

    it("leaves a row alone when nothing about it moves", async () => {
        const priced = retailPriceFor(2.65, 6.34);
        const settled = product({
            retailPrice: priced.retail,
            multiplier: priced.multiplier,
            landedCost: priced.cost,
            dutyCost: priced.duty,
            processingFee: priced.processing,
            variants: [
                { sku: "A", title: "One", storeVariantId: "1", zendropVariantId: 1, wholesale: 2.65, landedCost: priced.cost, retail: priced.retail, image: null, inStock: true },
            ],
        });
        const h = harness([settled]);
        try {
            const out = await h.svc.repriceAll();
            expect(out.changed).toBe(0);
            expect(h.saved).toHaveLength(0);
        } finally {
            h.restore();
        }
    });

    it("applies a duty rate the admin has set", async () => {
        const h = harness([product()], { dutyRatePct: 12, processingRatePct: 4.4, processingFixedUsd: 0.3 });
        try {
            await h.svc.repriceAll();
            const row = h.saved[0];
            expect(row.dutyCost).toBe(1.08); // 12% of 8.99
            expect(row.retailPrice).toBeGreaterThan(22.99);
        } finally {
            h.restore();
        }
    });

    it("reports what moved, so a reprice can be read before it is trusted", async () => {
        const h = harness([product(), product({ id: "p2", wholesalePrice: 40, shippingCost: 10, retailPrice: 999.99 })]);
        try {
            const out = await h.svc.repriceAll();
            expect(out.examined).toBe(2);
            expect(out.changed).toBe(2);
            expect(out.raised).toBe(1);
            expect(out.lowered).toBe(1);
            expect(out.averageBefore).toBeGreaterThan(0);
            expect(out.averageAfter).toBeGreaterThan(0);
        } finally {
            h.restore();
        }
    });

    it("never leaves a row priced at or under what the sale costs", async () => {
        const rows = [];
        for (let w = 0.5; w < 60; w += 7.3) rows.push(product({ id: `p${w}`, wholesalePrice: w, retailPrice: 0.99 }));
        const h = harness(rows);
        try {
            await h.svc.repriceAll();
            for (const row of h.saved) {
                expect(Number(row.retailPrice)).toBeGreaterThan(Number(row.landedCost));
            }
        } finally {
            h.restore();
        }
    });
});
