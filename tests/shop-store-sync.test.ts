import { StoreSyncService } from "../src/services/shop/store-sync-service";
import { AppDataSource } from "../src/db/data-source";
import { retailPriceFor } from "../src/config/shop-pricing";

/**
 * The store sync decides what the shop is allowed to sell, so its failure
 * modes are all expensive: a wrong variant map ships the wrong size, a bad
 * price sells below cost, and a product marked fulfillable that is not in the
 * store takes money for a parcel nobody can dispatch.
 */

const svc = () => new StoreSyncService();
const build = (storeVariants: any[], catalogVariants: any[], fallback = 0, shipping = 5, name = "Thing", image: string | null = "p.webp") =>
    (svc() as any).buildVariants(storeVariants, catalogVariants, fallback, shipping, name, image);

const sv = (id: string, sku: string | null, title = "Variant") =>
    ({ store_variant_id: id, variant_title: title, variant_sku: sku, variant_price: 99, variant_image_url: null });

describe("buildVariants", () => {
    it("joins store variants to catalogue variants on SKU, not on order", () => {
        // Deliberately reversed: a positional join would price these swapped.
        const { variants } = build(
            [sv("1", "AAA"), sv("2", "BBB")],
            [{ variant_id: 20, sku: "BBB", price: "30.00" }, { variant_id: 10, sku: "AAA", price: "10.00" }],
        );
        expect(variants).toHaveLength(2);
        expect(variants.find((v: any) => v.storeVariantId === "1").wholesale).toBe(10);
        expect(variants.find((v: any) => v.storeVariantId === "2").wholesale).toBe(30);
    });

    it("falls back to position when the store variant carries no SKU", () => {
        const { variants } = build(
            [sv("1", null), sv("2", null)],
            [{ variant_id: 10, sku: null, price: "10.00" }, { variant_id: 20, sku: null, price: "30.00" }],
        );
        expect(variants.map((v: any) => v.wholesale)).toEqual([10, 30]);
    });

    it("falls back to position when a SKU is duplicated, since it is then not a key", () => {
        const { variants } = build(
            [sv("1", "SAME"), sv("2", "SAME")],
            [{ variant_id: 10, sku: "SAME", price: "10.00" }, { variant_id: 20, sku: "SAME", price: "30.00" }],
        );
        expect(variants.map((v: any) => v.wholesale)).toEqual([10, 30]);
    });

    it("prices each variant from its own wholesale, not the product's", () => {
        const { variants } = build(
            [sv("1", "A"), sv("2", "B")],
            [{ variant_id: 1, sku: "A", price: "10.00" }, { variant_id: 2, sku: "B", price: "100.00" }],
            0,
            5,
        );
        expect(variants[0].retail).toBe(retailPriceFor(10, 5).retail);
        expect(variants[1].retail).toBe(retailPriceFor(100, 5).retail);
        expect(variants[0].retail).not.toBe(variants[1].retail);
    });

    it("drops the absurd price Zendrop pushed rather than offering it", () => {
        // Real record: a knit sweater variant arrived in the store at
        // $52,257.76. Marked up it would have been a five figure listing.
        const { variants, dropped } = build(
            [sv("1", "OK"), sv("2", "MAD")],
            [{ variant_id: 1, sku: "OK", price: "20.00" }, { variant_id: 2, sku: "MAD", price: "52257.76" }],
        );
        expect(variants).toHaveLength(1);
        expect(variants[0].storeVariantId).toBe("1");
        expect(dropped).toBe(1);
    });

    it("drops a variant with no Shopify id, because it could never be shipped", () => {
        const { variants, dropped } = build(
            [{ store_variant_id: "", variant_title: "x", variant_sku: "A", variant_price: 1, variant_image_url: null }],
            [{ variant_id: 1, sku: "A", price: "20.00" }],
        );
        expect(variants).toHaveLength(0);
        expect(dropped).toBe(1);
    });

    it("drops a variant with no usable wholesale instead of guessing one", () => {
        const { variants } = build([sv("1", "A")], [{ variant_id: 1, sku: "A", price: "0" }], 0, 5);
        expect(variants).toHaveLength(0);
    });

    it("includes shipping in the landed cost every variant is marked up from", () => {
        const { variants } = build([sv("1", "A")], [{ variant_id: 1, sku: "A", price: "10.00" }], 0, 7.5);
        expect(variants[0].landedCost).toBe(17.5);
        expect(variants[0].retail).toBeGreaterThan(17.5);
    });

    it("names a variant from its size and colour", () => {
        const { variants } = build([sv("1", "A")], [{ variant_id: 1, sku: "A", price: "10.00", size: "XL", color: "Black" }]);
        expect(variants[0].title).toBe("XL / Black");
    });

    it("does not repeat the product name as the variant title", () => {
        const { variants } = build([sv("1", "A", "Thing")], [{ variant_id: 1, sku: "A", price: "10.00" }], 0, 5, "Thing");
        expect(variants[0].title).toBe("Default");
    });

    it("treats an explicit false as out of stock and a null as in stock", () => {
        const { variants } = build(
            [sv("1", "A"), sv("2", "B")],
            [
                { variant_id: 1, sku: "A", price: "10.00", available: false },
                { variant_id: 2, sku: "B", price: "10.00", available: null },
            ],
        );
        expect(variants.find((v: any) => v.storeVariantId === "1").inStock).toBe(false);
        expect(variants.find((v: any) => v.storeVariantId === "2").inStock).toBe(true);
    });

    it("uses the product image when a variant has none of its own", () => {
        const { variants } = build([sv("1", "A")], [{ variant_id: 1, sku: "A", price: "10.00" }], 0, 5, "Thing", "prod.webp");
        expect(variants[0].image).toBe("prod.webp");
    });
});

/**
 * syncOne is where a product becomes sellable or does not. Every path that
 * cannot guarantee a shippable parcel at a known cost must leave the row
 * unfulfillable.
 */
describe("syncOne", () => {
    const entry = { import_list_id: 1, product_id: 7, product_name: "Thing", product_image_url: null, import_status: "in_store", store_product_id: "999" };

    function harness(responses: Record<string, any>) {
        const s = svc();
        const saved: any[] = [];
        (s as any).productRepo = {
            findOne: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockImplementation((d: any) => ({ ...d })),
            save: jest.fn().mockImplementation(async (r: any) => { saved.push({ ...r }); return r; }),
        };
        const categories: any[] = [];
        (s as any).categoryRepo = {
            findOne: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockImplementation((d: any) => ({ ...d })),
            save: jest.fn().mockImplementation(async (c: any) => { categories.push({ ...c }); return c; }),
        };
        (harness as any).categories = categories;
        jest.spyOn(require("../src/services/shop/zendrop-client"), "callZendropTool")
            .mockImplementation(async (tool: any) => responses[tool as string]);
        return { s, saved, categories };
    }

    afterEach(() => jest.restoreAllMocks());

    const linked = {
        get_my_product: { store_product_id: "999", store_sync_status: "synced", zendrop_linked: true, variants: [sv("1", "A")] },
        get_catalog_product: { id: 7, name: "Thing", price: "10.00", images: [], variants: [{ variant_id: 1, sku: "A", price: "10.00" }], availability: { in_stock: true } },
        get_catalog_shipping_estimate: { shipping_options: [{ type: "regular", price: 5, estimated_delivery: "6 days" }] },
    };

    it("marks a linked, priced, in-store product fulfillable", async () => {
        const { s, saved } = harness(linked);
        await expect(s.syncOne(entry as any)).resolves.toBe(true);
        expect(saved[0].isFulfillable).toBe(true);
        expect(saved[0].shopifyProductId).toBe("999");
        expect(saved[0].variants).toHaveLength(1);
    });

    it("refuses to price a product Zendrop will not ship to the pricing market", async () => {
        const { s, saved } = harness({ ...linked, get_catalog_shipping_estimate: { shipping_options: [] } });
        await expect(s.syncOne(entry as any)).resolves.toBe(false);
        expect(saved[0].isFulfillable).toBe(false);
    });

    it("will not sell a product the store has not finished syncing", async () => {
        const { s, saved } = harness({ ...linked, get_my_product: { ...linked.get_my_product, store_sync_status: "pending" } });
        await expect(s.syncOne(entry as any)).resolves.toBe(false);
        expect(saved[0].isFulfillable).toBe(false);
    });

    it("will not sell a product that has no Shopify id", async () => {
        const { s, saved } = harness({ ...linked, get_my_product: { ...linked.get_my_product, store_product_id: null } });
        await expect(s.syncOne(entry as any)).resolves.toBe(false);
        expect(saved[0].isFulfillable).toBe(false);
    });

    it("records the category and marks it carried, or the filter comes back empty", async () => {
        const { s, saved, categories } = harness({
            ...linked,
            get_catalog_product: { ...linked.get_catalog_product, categories: [{ id: 13, name: "Jewelry" }] },
        });
        await s.syncOne(entry as any);
        expect(saved[0].categoryId).toBe(13);
        expect(saved[0].categoryName).toBe("Jewelry");
        expect(categories[0]).toMatchObject({ zendropCategoryId: 13, name: "Jewelry", isCarried: true });
    });

    it("leaves the category alone when Zendrop gives none", async () => {
        const { s, saved, categories } = harness({
            ...linked,
            get_catalog_product: { ...linked.get_catalog_product, categories: [] },
        });
        await s.syncOne(entry as any);
        expect(saved[0].categoryId).toBeUndefined();
        expect(categories).toHaveLength(0);
    });

    it("lists at the cheapest variant, so the grid never undercuts the detail page", async () => {
        const { s, saved } = harness({
            ...linked,
            get_my_product: { ...linked.get_my_product, variants: [sv("1", "A"), sv("2", "B")] },
            get_catalog_product: {
                ...linked.get_catalog_product,
                variants: [{ variant_id: 1, sku: "A", price: "50.00" }, { variant_id: 2, sku: "B", price: "10.00" }],
            },
        });
        await s.syncOne(entry as any);
        const cheapest = Math.min(...saved[0].variants.map((v: any) => v.retail));
        expect(Number(saved[0].retailPrice)).toBe(cheapest);
    });
});

/**
 * Two API replicas both schedule this pass. Running it twice at once would
 * double the request rate at an upstream that rate limits sustained traffic
 * and then refuses everything for minutes, which is how the first attempt at
 * this sync lost 95 of 125 products to a Cloudflare challenge.
 */
describe("syncStore locking", () => {
    const original = (AppDataSource as any).createQueryRunner;
    let calls: any[][];
    let released: number;

    const mockRunner = (ok: boolean) => {
        calls = [];
        released = 0;
        (AppDataSource as any).createQueryRunner = () => ({
            connect: async () => undefined,
            // One object for every query, so the test fails if the lock and
            // the unlock are ever issued on different connections.
            query: async (...args: any[]) => {
                calls.push(args);
                return [{ ok }];
            },
            release: async () => { released++; },
        });
    };

    afterEach(() => {
        (AppDataSource as any).createQueryRunner = original;
        jest.restoreAllMocks();
    });

    it("does nothing when another replica already holds the lock", async () => {
        mockRunner(false);
        const s = svc();
        const inner = jest.spyOn(s as any, "runSync");
        const r = await s.syncStore();
        expect(inner).not.toHaveBeenCalled();
        expect(r.synced).toBe(0);
        expect(r.errors[0]).toMatch(/already running/);
        expect(calls).toHaveLength(1);
        expect(released).toBe(1);
    });

    it("releases the lock on the same connection that took it", async () => {
        mockRunner(true);
        const s = svc();
        jest.spyOn(s as any, "runSync").mockResolvedValue({ listed: 1, synced: 1, skipped: 0, delisted: 0, errors: [] });
        await s.syncStore();
        expect(calls).toHaveLength(2);
        expect(String(calls[0][0])).toMatch(/pg_try_advisory_lock/);
        expect(String(calls[1][0])).toMatch(/pg_advisory_unlock/);
        expect(released).toBe(1);
    });

    it("still unlocks and closes the connection when the pass throws", async () => {
        mockRunner(true);
        const s = svc();
        jest.spyOn(s as any, "runSync").mockRejectedValue(new Error("upstream down"));
        await expect(s.syncStore()).rejects.toThrow("upstream down");
        expect(String(calls[1][0])).toMatch(/pg_advisory_unlock/);
        expect(released).toBe(1);
    });
});
