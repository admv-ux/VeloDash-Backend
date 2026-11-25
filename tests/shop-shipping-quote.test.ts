import { ShippingQuoteService, BASELINE_COUNTRY } from "../src/services/shop/shipping-quote-service";

/**
 * Shipping to anywhere but the US decides whether an order makes money.
 *
 * Measured on the live catalogue: a graphite case costs $4.58 to the US and
 * $12.39 to Australia, while a leather jacket costs $44.77 to the US and
 * $22.49 to Britain. A single "international shipping" surcharge would
 * overcharge Europe and undercharge Australia on the same day, which is why
 * every quote here is per product per country.
 */

const svc = () => new ShippingQuoteService();

const product = (over: any = {}) => ({
    id: over.id || "p1",
    zendropProductId: over.zendropProductId || 1,
    name: over.name || "Thing",
    shippingCost: over.shippingCost ?? 5,
    estimatedDelivery: over.estimatedDelivery ?? "8 days",
    shippingByCountry: over.shippingByCountry ?? {},
});

function harness(fetchImpl?: (id: number, country: string) => Promise<any>) {
    const s = svc();
    const updates: any[] = [];
    (s as any).productRepo = {
        update: jest.fn(async (where: any, patch: any) => { updates.push({ where, patch }); }),
    };
    const calls: any[] = [];
    jest.spyOn(require("../src/services/shop/zendrop-client"), "zendropConfigured").mockReturnValue(true);
    jest.spyOn(require("../src/services/shop/zendrop-client"), "callZendropTool")
        .mockImplementation(async (_tool: any, args: any) => {
            calls.push(args);
            if (fetchImpl) return fetchImpl(args.product_id, args.country_code);
            return { shipping_options: [{ type: "regular", price: 9, estimated_delivery: "10 days" }] };
        });
    return { s, updates, calls };
}

afterEach(() => jest.restoreAllMocks());

describe("surchargePerUnit", () => {
    it("charges the difference when the destination costs more", () => {
        // The real graphite case: $4.58 US, $12.39 Australia.
        expect(svc().surchargePerUnit(product({ shippingCost: 4.58 }) as any, { cost: 12.39, eta: null }))
            .toBeCloseTo(7.81, 2);
    });

    it("charges nothing when the destination is cheaper than the US", () => {
        // The real leather jacket: $44.77 US, $22.49 Britain. Charging a
        // negative would be refunding shipping we already collected.
        expect(svc().surchargePerUnit(product({ shippingCost: 44.77 }) as any, { cost: 22.49, eta: null }))
            .toBe(0);
    });

    it("charges nothing when the two match", () => {
        expect(svc().surchargePerUnit(product({ shippingCost: 5 }) as any, { cost: 5, eta: null })).toBe(0);
    });

    it("carries the card fee on the surcharge too", () => {
        // 7.81 of courier at 4.4% leaves 7.81 short by the fee on it. The
        // shopper pays 8.17, we net the 7.81 the courier costs.
        const out = svc().surchargePerUnit(product({ shippingCost: 4.58 }) as any, { cost: 12.39, eta: null }, 4.4);
        expect(out).toBeCloseTo(8.17, 2);
        expect(out * (1 - 0.044)).toBeGreaterThanOrEqual(7.81);
    });

    it("still charges nothing extra on a cheaper destination, fee or not", () => {
        expect(svc().surchargePerUnit(product({ shippingCost: 44.77 }) as any, { cost: 22.49, eta: null }, 4.4)).toBe(0);
    });

    it("ignores a fee rate that makes no sense", () => {
        const sane = svc().surchargePerUnit(product({ shippingCost: 1 }) as any, { cost: 11, eta: null }, 500);
        expect(sane).toBeCloseTo(20, 2); // clamped at 50%, never negative or infinite
        expect(svc().surchargePerUnit(product({ shippingCost: 1 }) as any, { cost: 11, eta: null }, -5)).toBe(10);
    });
});

describe("quoteMany", () => {
    it("answers the baseline market from the row without calling upstream", async () => {
        const { s, calls } = harness();
        const out = await s.quoteMany([product({ shippingCost: 6.99 }) as any], BASELINE_COUNTRY);
        expect(out.get("p1")).toEqual({ cost: 6.99, eta: "8 days" });
        expect(calls).toHaveLength(0);
    });

    it("uses a fresh cached quote rather than asking again", async () => {
        const cached = { GB: { cost: 3.37, eta: "9 days", at: new Date().toISOString() } };
        const { s, calls } = harness();
        const out = await s.quoteMany([product({ shippingByCountry: cached }) as any], "GB");
        expect(out.get("p1")).toEqual({ cost: 3.37, eta: "9 days" });
        expect(calls).toHaveLength(0);
    });

    it("refetches a quote old enough to be stale", async () => {
        const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
        const { s, calls } = harness();
        const out = await s.quoteMany([product({ shippingByCountry: { GB: { cost: 1, eta: null, at: old } } }) as any], "GB");
        expect(calls).toHaveLength(1);
        expect(out.get("p1")!.cost).toBe(9);
    });

    it("remembers a fetched quote so the next basket is instant", async () => {
        const { s, updates } = harness();
        await s.quoteMany([product() as any], "DE");
        expect(updates).toHaveLength(1);
        expect(updates[0].patch.shippingByCountry.DE).toMatchObject({ cost: 9 });
        expect(updates[0].patch.shippingByCountry.DE.at).toBeTruthy();
    });

    it("caches a definite 'ships nowhere there' so the dead end is not re-asked", async () => {
        // Every US-supplier product in this catalogue answers this way for
        // every country but the US.
        const { s, updates } = harness(async () => ({ shipping_options: [] }));
        const out = await s.quoteMany([product() as any], "DE");
        expect(out.get("p1")).toBeNull();
        expect(updates[0].patch.shippingByCountry.DE).toBeNull();
    });

    it("honours a cached null without calling upstream", async () => {
        const { s, calls } = harness();
        const out = await s.quoteMany([product({ shippingByCountry: { DE: null } }) as any], "DE");
        expect(out.get("p1")).toBeNull();
        expect(calls).toHaveLength(0);
    });

    it("does not cache an upstream failure as a permanent no", async () => {
        // A 429 is not an answer about where the supplier ships. Writing it
        // to the cache would block that country for two weeks.
        const { s, updates } = harness(async () => { throw new Error("429 rate limited"); });
        const out = await s.quoteMany([product() as any], "DE");
        expect(out.get("p1")).toBeNull();
        expect(updates).toHaveLength(0);
    });

    it("prices a mixed basket, keeping each product's own quote", async () => {
        const { s } = harness(async (id) => ({
            shipping_options: [{ type: "regular", price: id === 1 ? 12.39 : 22.49, estimated_delivery: null }],
        }));
        const out = await s.quoteMany(
            [product({ id: "a", zendropProductId: 1 }) as any, product({ id: "b", zendropProductId: 2 }) as any],
            "AU",
        );
        expect(out.get("a")!.cost).toBe(12.39);
        expect(out.get("b")!.cost).toBe(22.49);
    });

    it("refuses an unseen destination when Zendrop is not configured", async () => {
        const s = svc();
        (s as any).productRepo = { update: jest.fn() };
        jest.spyOn(require("../src/services/shop/zendrop-client"), "zendropConfigured").mockReturnValue(false);
        const out = await s.quoteMany([product() as any], "DE");
        expect(out.get("p1")).toBeNull();
    });
});

describe("normaliseCountry", () => {
    it("accepts a two letter code in any case", () => {
        expect(ShippingQuoteService.normaliseCountry("gb")).toBe("GB");
        expect(ShippingQuoteService.normaliseCountry(" de ")).toBe("DE");
    });

    it("rejects anything else", () => {
        for (const bad of ["", "USA", "1", "G", null, undefined, "US; DROP TABLE"]) {
            expect(ShippingQuoteService.normaliseCountry(bad)).toBeNull();
        }
    });
});
