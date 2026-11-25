import { StoreSyncService, UNSELLABLE } from "../src/services/shop/store-sync-service";
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

    it("marks a variant up from goods plus shipping, and still covers the card fee", () => {
        const { variants } = build([sv("1", "A")], [{ variant_id: 1, sku: "A", price: "10.00" }], 0, 7.5);
        // Supplier cost 17.50 sets the band; landedCost also carries the
        // processor's cut, which is why it is not 17.50 any more.
        expect(variants[0].retail).toBe(34.99);
        expect(variants[0].landedCost).toBe(19.34);
        expect(variants[0].retail).toBeGreaterThan(variants[0].landedCost);
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

    it("still records an unshippable NEW product, with money columns a database will accept", async () => {
        // wholesalePrice is NOT NULL with no default. Leaving it undefined made
        // the insert throw, so seven products Zendrop will not ship to the US
        // were dropped on the floor instead of appearing in the admin.
        const { s, saved } = harness({ ...linked, get_catalog_shipping_estimate: { shipping_options: [] } });
        await s.syncOne(entry as any);
        for (const col of ["wholesalePrice", "shippingCost", "landedCost", "multiplier", "retailPrice"]) {
            expect(typeof saved[0][col]).toBe("number");
        }
        expect(saved[0].name).toBeTruthy();
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

/**
 * Why a product cannot be sold has to be recorded, not just that it cannot.
 * The dashboard could previously only say "155 cannot be shipped", which is
 * a number nobody can act on: 148 of those were one button away from selling
 * and 7 were never going to.
 */
describe("unsellableReason", () => {
    const entry = { import_list_id: 1, product_id: 7, product_name: "Thing", product_image_url: null, import_status: "in_store", store_product_id: "999" };

    function harness(responses: Record<string, any>) {
        const s = svc();
        const saved: any[] = [];
        (s as any).productRepo = {
            findOne: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockImplementation((d: any) => ({ ...d })),
            save: jest.fn().mockImplementation(async (r: any) => { saved.push({ ...r }); return r; }),
        };
        (s as any).categoryRepo = {
            findOne: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockImplementation((d: any) => ({ ...d })),
            save: jest.fn().mockResolvedValue(undefined),
        };
        jest.spyOn(require("../src/services/shop/zendrop-client"), "callZendropTool")
            .mockImplementation(async (tool: any) => responses[tool as string]);
        return { s, saved };
    }

    afterEach(() => jest.restoreAllMocks());

    const ok = {
        get_my_product: { store_product_id: "999", store_sync_status: "synced", zendrop_linked: true, variants: [sv("1", "A")] },
        get_catalog_product: { id: 7, name: "Thing", price: "10.00", images: [], variants: [{ variant_id: 1, sku: "A", price: "10.00" }], availability: { in_stock: true } },
        get_catalog_shipping_estimate: { shipping_options: [{ type: "regular", price: 5, estimated_delivery: "6 days" }] },
    };

    it("clears the reason once a product is sellable", async () => {
        const { s, saved } = harness(ok);
        await s.syncOne(entry as any);
        expect(saved[0].isFulfillable).toBe(true);
        expect(saved[0].unsellableReason).toBeNull();
    });

    it("blames the missing shipping quote when there is none", async () => {
        const { s, saved } = harness({ ...ok, get_catalog_shipping_estimate: { shipping_options: [] } });
        await s.syncOne(entry as any);
        expect(saved[0].unsellableReason).toBe(UNSELLABLE.NO_SHIPPING_QUOTE);
    });

    it("blames the store when the product is not in it", async () => {
        const { s, saved } = harness({ ...ok, get_my_product: { ...ok.get_my_product, store_product_id: null } });
        await s.syncOne(entry as any);
        expect(saved[0].unsellableReason).toBe(UNSELLABLE.NOT_IN_STORE);
    });

    it("blames the store while Shopify is still syncing it", async () => {
        const { s, saved } = harness({ ...ok, get_my_product: { ...ok.get_my_product, store_sync_status: "pending" } });
        await s.syncOne(entry as any);
        expect(saved[0].unsellableReason).toBe(UNSELLABLE.NOT_IN_STORE);
    });

    it("blames the variants when the product IS in the store but none can be ordered", async () => {
        const { s, saved } = harness({ ...ok, get_my_product: { ...ok.get_my_product, variants: [] } });
        await s.syncOne(entry as any);
        expect(saved[0].unsellableReason).toBe(UNSELLABLE.NO_VARIANTS);
    });
});

/**
 * Pushing a product into the Shopify store is the fix for the largest group
 * of unsellable rows. Zendrop only fulfils what the store carries, so this
 * is the difference between a listing we can dispatch and one we cannot.
 */
describe("pushToStore", () => {
    afterEach(() => jest.restoreAllMocks());

    const inList = { import_list_id: 50, product_id: 7, product_name: "Thing", product_image_url: null, import_status: "imported", store_product_id: null };

    function harness(opts: { lists: any[][]; tools: Record<string, any>; syncResult?: boolean }) {
        const s = svc();
        const calls: Array<{ tool: string; args: any }> = [];
        let listCall = 0;
        jest.spyOn(s as any, "importList").mockImplementation(async () => opts.lists[Math.min(listCall++, opts.lists.length - 1)]);
        const syncOne = jest.spyOn(s, "syncOne").mockResolvedValue(opts.syncResult ?? true);
        jest.spyOn(require("../src/services/shop/zendrop-client"), "callZendropTool")
            .mockImplementation(async (tool: any, args: any) => {
                calls.push({ tool, args });
                return opts.tools[tool as string];
            });
        return { s, calls, syncOne };
    }

    it("does nothing, and talks to nobody, for an empty list", async () => {
        const { s, calls } = harness({ lists: [[]], tools: {} });
        await expect(s.pushToStore([])).resolves.toEqual({ attempted: 0, nowSellable: 0, failed: 0, results: [] });
        expect(calls).toHaveLength(0);
    });

    it("adds a product that is not in the import list, pushes it, then syncs it", async () => {
        const { s, calls, syncOne } = harness({
            lists: [[], [inList]],
            tools: {
                add_my_product: { message: "Product successfully added to your import list." },
                import_my_product: { operation_id: 50, status: "pending" },
                get_my_product_import_operation: { status: "completed", store_product_id: "15562188685405", failed_reason: null },
            },
        });
        const summary = await s.pushToStore([7]);
        expect(calls.map((c) => c.tool)).toEqual(["add_my_product", "import_my_product", "get_my_product_import_operation"]);
        expect(calls[0].args.product_id).toBe(7);
        expect(calls[1].args.import_list_id).toBe(50);
        expect(syncOne).toHaveBeenCalledTimes(1);
        // The store id Shopify handed back must reach syncOne, or the row is
        // written as "not in store" straight after being put in the store.
        expect(syncOne.mock.calls[0][0].store_product_id).toBe("15562188685405");
        expect(summary).toMatchObject({ attempted: 1, nowSellable: 1, failed: 0 });
    });

    it("does not add a product that is already in the import list", async () => {
        const { s, calls } = harness({
            lists: [[inList]],
            tools: {
                import_my_product: { operation_id: 50 },
                get_my_product_import_operation: { status: "completed", store_product_id: "1", failed_reason: null },
            },
        });
        await s.pushToStore([7]);
        expect(calls.map((c) => c.tool)).not.toContain("add_my_product");
    });

    it("skips straight to syncing a product already in the store", async () => {
        const { s, calls, syncOne } = harness({
            lists: [[{ ...inList, import_status: "in_store", store_product_id: "999" }]],
            tools: {},
        });
        const summary = await s.pushToStore([7]);
        expect(calls).toHaveLength(0);
        expect(syncOne).toHaveBeenCalledTimes(1);
        expect(summary.nowSellable).toBe(1);
    });

    it("reports a refused push and does not pretend it synced", async () => {
        const { s, syncOne } = harness({
            lists: [[inList]],
            tools: {
                import_my_product: { operation_id: 50 },
                get_my_product_import_operation: { status: "failed", store_product_id: null, failed_reason: "Shopify rejected the product" },
            },
        });
        const summary = await s.pushToStore([7]);
        expect(syncOne).not.toHaveBeenCalled();
        expect(summary).toMatchObject({ attempted: 1, nowSellable: 0, failed: 1 });
        expect(summary.results[0].message).toBe("Shopify rejected the product");
    });

    it("says so when Zendrop will not even put it on the import list", async () => {
        const { s, syncOne } = harness({
            lists: [[], []],
            tools: { add_my_product: { message: "nope" } },
        });
        const summary = await s.pushToStore([7]);
        expect(syncOne).not.toHaveBeenCalled();
        expect(summary.failed).toBe(1);
        expect(summary.results[0].message).toMatch(/import list/i);
    });

    it("counts a product that reaches the store but still cannot be sold as a failure", async () => {
        const { s } = harness({
            lists: [[{ ...inList, import_status: "in_store", store_product_id: "999" }]],
            tools: {},
            syncResult: false,
        });
        const summary = await s.pushToStore([7]);
        expect(summary).toMatchObject({ nowSellable: 0, failed: 1 });
        expect(summary.results[0].message).toMatch(/still not sellable/i);
    });

    it("keeps going after one product throws", async () => {
        const s = svc();
        jest.spyOn(s as any, "importList").mockResolvedValue([
            { ...inList, product_id: 7, import_status: "in_store", store_product_id: "a" },
            { ...inList, product_id: 8, import_status: "in_store", store_product_id: "b" },
        ]);
        jest.spyOn(s, "syncOne")
            .mockRejectedValueOnce(new Error("upstream exploded"))
            .mockResolvedValueOnce(true);
        const summary = await s.pushToStore([7, 8]);
        expect(summary).toMatchObject({ attempted: 2, nowSellable: 1, failed: 1 });
        expect(summary.results[0].message).toBe("upstream exploded");
    });
});

/**
 * The delist pass is the one step that can take products OFF sale, so it has
 * to be judged against what is in the store now, not against a snapshot
 * taken before a 35 minute pass began.
 *
 * Real incident: a sync read the import list, spent 35 minutes syncing, and
 * then delisted 65 products as "Removed from the store upstream" that a push
 * had added to the store during those same 35 minutes.
 */
describe("the delist pass", () => {
    afterEach(() => jest.restoreAllMocks());

    const entry = (product_id: number) => ({
        import_list_id: product_id,
        product_id,
        product_name: `P${product_id}`,
        product_image_url: null,
        import_status: "in_store",
        store_product_id: String(product_id),
    });

    function harness(lists: any[][]) {
        const svc = new StoreSyncService();
        let call = 0;
        jest.spyOn(svc as any, "importList").mockImplementation(async () => lists[Math.min(call++, lists.length - 1)]);
        jest.spyOn(svc, "syncOne").mockResolvedValue(true);
        const updates: any[] = [];
        const qb: any = {
            update: () => qb,
            set: (v: any) => { updates.push({ set: v }); return qb; },
            where: () => qb,
            andWhere: (_sql: string, params: any) => { updates[updates.length - 1].keep = params?.keep; return qb; },
            execute: async () => ({ affected: 0 }),
        };
        (svc as any).productRepo = { createQueryBuilder: () => qb };
        return { svc, updates, importListCalls: () => call };
    }

    it("re-reads the import list before deciding what has left the store", async () => {
        const before = [entry(1), entry(2)];
        const after = [entry(1), entry(2), entry(3)]; // 3 arrived during the pass
        const { svc, updates, importListCalls } = harness([before, after]);
        await (svc as any).runSync(undefined);
        expect(importListCalls()).toBe(2);
        // 3 must be in `keep`, or it is delisted the moment it goes on sale.
        expect(updates[0].keep).toEqual([1, 2, 3]);
    });

    it("skips delisting entirely rather than delisting against a stale list", async () => {
        const svc = new StoreSyncService();
        let call = 0;
        jest.spyOn(svc as any, "importList").mockImplementation(async () => {
            if (call++ === 0) return [entry(1)];
            throw new Error("Zendrop request fetch failed");
        });
        jest.spyOn(svc, "syncOne").mockResolvedValue(true);
        const updates: any[] = [];
        const qb: any = {
            update: () => qb, set: (v: any) => { updates.push(v); return qb; },
            where: () => qb, andWhere: () => qb, execute: async () => ({ affected: 99 }),
        };
        (svc as any).productRepo = { createQueryBuilder: () => qb };

        const result = await (svc as any).runSync(undefined);
        expect(updates).toHaveLength(0);
        expect(result.delisted).toBe(0);
    });

    it("does not delist at all on a partial pass", async () => {
        const { svc, updates } = harness([[entry(1), entry(2)]]);
        await (svc as any).runSync(1);
        expect(updates).toHaveLength(0);
    });

    it("holds the same lock for a push as for a sync, so the two cannot overlap", async () => {
        // Separate locks let a push add products to the store while a sync
        // was mid pass, and the sync then delisted every one of them.
        const src = require("fs").readFileSync(
            require("path").join(__dirname, "../src/services/shop/store-sync-service.ts"),
            "utf8",
        );
        expect(src).toMatch(/const PUSH_LOCK_KEY = SYNC_LOCK_KEY;/);
    });
});

/**
 * The endpoint behind the admin's "Push all" button must not claim to have
 * started something the lock then refuses. It did exactly that: it answered
 * "Pushing 53 products" and a sync holding the lock turned the push away a
 * second later, so the admin saw a success message and nothing happened.
 */
describe("starting a bulk push", () => {
    // createQueryRunner lives on DataSource.prototype, so spyOn cannot see it
    // on the instance; it is swapped out and put back by hand.
    const realCreateQueryRunner = AppDataSource.createQueryRunner;
    afterEach(() => {
        (AppDataSource as any).createQueryRunner = realCreateQueryRunner;
        jest.restoreAllMocks();
    });

    function harness(lockGranted: boolean, rowCount = 3) {
        const queries: string[] = [];
        let released = false;
        const runner: any = {
            connect: jest.fn().mockResolvedValue(undefined),
            query: jest.fn(async (sql: string) => {
                queries.push(sql);
                if (sql.includes("pg_try_advisory_lock")) return [{ ok: lockGranted }];
                return [{}];
            }),
            release: jest.fn(async () => { released = true; }),
        };
        (AppDataSource as any).createQueryRunner = () => runner;

        const svc = new StoreSyncService();
        (svc as any).productRepo = {
            find: jest.fn().mockResolvedValue(
                Array.from({ length: rowCount }, (_, i) => ({ zendropProductId: 100 + i })),
            ),
        };
        const push = jest.spyOn(svc, "pushToStore").mockResolvedValue({ attempted: rowCount, nowSellable: rowCount, failed: 0, results: [] });
        return { svc, runner, queries, push, wasReleased: () => released };
    }

    it("says it did not start when a sync holds the lock, and queues nothing", async () => {
        const { svc, push, wasReleased } = harness(false);
        await expect(svc.startPushAllNotInStore()).resolves.toEqual({ started: false, queued: 0 });
        expect(push).not.toHaveBeenCalled();
        expect(wasReleased()).toBe(true);
    });

    it("reports the real queue size and starts the work", async () => {
        const { svc, push } = harness(true, 5);
        const res = await svc.startPushAllNotInStore();
        expect(res).toEqual({ started: true, queued: 5 });
        expect(push).toHaveBeenCalledWith([100, 101, 102, 103, 104]);
    });

    it("returns before the push finishes, rather than waiting out an hour of work", async () => {
        const { svc } = harness(true, 2);
        let settled = false;
        jest.spyOn(svc, "pushToStore").mockImplementation(
            () => new Promise((r) => setTimeout(() => { settled = true; r({ attempted: 2, nowSellable: 2, failed: 0, results: [] }); }, 50)),
        );
        const res = await svc.startPushAllNotInStore();
        expect(res.started).toBe(true);
        expect(settled).toBe(false);
    });

    it("releases the lock once the work is done, not before", async () => {
        const { svc, queries, wasReleased } = harness(true, 1);
        await svc.startPushAllNotInStore();
        expect(queries.some((q) => q.includes("pg_advisory_unlock"))).toBe(false);
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        expect(queries.some((q) => q.includes("pg_advisory_unlock"))).toBe(true);
        expect(wasReleased()).toBe(true);
    });

    it("honours a limit", async () => {
        const { svc } = harness(true, 2);
        const res = await svc.startPushAllNotInStore(2);
        expect(res.queued).toBe(2);
    });
});
