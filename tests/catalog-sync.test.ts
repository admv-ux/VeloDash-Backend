/**
 * Sync rules worth pinning. The expensive mistake here is pricing a product
 * without a real shipping quote: shipping is most of the landed cost on cheap
 * items, so a guess is how stock ends up selling below what we pay Zendrop.
 */

jest.mock("../src/services/shop/zendrop-client", () => ({
    callZendropTool: jest.fn(),
    zendropConfigured: () => true,
}));

import { CatalogSyncService } from "../src/services/shop/catalog-sync-service";
import { callZendropTool } from "../src/services/shop/zendrop-client";

const mockCall = callZendropTool as jest.MockedFunction<typeof callZendropTool>;

function buildService() {
    const svc = new CatalogSyncService();
    const saved: any[] = [];
    (svc as any).productRepo = {
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation((d: any) => ({ ...d })),
        save: jest.fn().mockImplementation(async (e: any) => { saved.push({ ...e }); return e; }),
    };
    (svc as any).categoryRepo = {
        findOne: jest.fn().mockResolvedValue({ zendropCategoryId: 61, name: "Apparel", isCarried: false }),
        create: jest.fn().mockImplementation((d: any) => ({ ...d })),
        save: jest.fn().mockImplementation(async (e: any) => e),
    };
    return { svc, saved };
}

/** Route each mocked tool call to the right canned answer. */
function wire(products: any[], shipping: Record<number, any>) {
    mockCall.mockImplementation(async (tool: string, args: any) => {
        if (tool === "get_catalog_products") return { total: products.length, products } as any;
        if (tool === "get_catalog_shipping_estimate") {
            const s = shipping[args.product_id];
            if (!s) throw new Error("no quote");
            return { shipping_options: s } as any;
        }
        throw new Error("unexpected tool " + tool);
    });
}

beforeEach(() => mockCall.mockReset());

describe("syncCategoryPage", () => {
    it("prices a product from its real wholesale and shipping", async () => {
        wire(
            [{ id: 2693395, name: "Plus Size Trousers for Men", price: "7.99", supplier: { name: "Zendrop Fulfillment", country: "CN" }, availability: { in_stock: true }, images: [{ id: 1, url: "a.webp" }] }],
            { 2693395: [{ type: "regular", price: 13.68, estimated_delivery: "8 days" }] },
        );
        const { svc, saved } = buildService();

        const result = await svc.syncCategoryPage(61, 1, 50);

        expect(result).toEqual({ saved: 1, skipped: 0 });
        expect(saved).toHaveLength(1);
        expect(saved[0]).toMatchObject({
            zendropProductId: 2693395,
            wholesalePrice: 7.99,
            shippingCost: 13.68,
            // 21.67 of supplier cost picks the band; the stored landed cost
            // also carries the card fee taken out of the sale.
            dutyCost: 0,
            processingFee: 2.19,
            landedCost: 23.86,
            multiplier: 1.8,
            retailPrice: 42.99,
            categoryId: 61,
            categoryName: "Apparel",
            shipsFrom: "CN",
            estimatedDelivery: "8 days",
            images: ["a.webp"],
        });
    });

    it("skips a product Zendrop will not quote shipping for, rather than guessing", async () => {
        wire([{ id: 1, name: "No quote", price: "5.00" }], {});
        const { svc, saved } = buildService();

        const result = await svc.syncCategoryPage(61);

        expect(result).toEqual({ saved: 0, skipped: 1 });
        expect(saved).toEqual([]);
    });

    it("takes the cheapest shipping option when several are offered", async () => {
        wire(
            [{ id: 7, name: "Multi", price: "10.00" }],
            { 7: [
                { type: "express", price: 22.00, estimated_delivery: "3 days" },
                { type: "regular", price: 5.00, estimated_delivery: "9 days" },
            ] },
        );
        const { svc, saved } = buildService();

        await svc.syncCategoryPage(61);

        expect(saved[0].shippingCost).toBe(5);
        expect(saved[0].landedCost).toBe(16.62); // 15 supplier + 1.62 card fee
        expect(saved[0].multiplier).toBe(1.8); // 15 sits in the middle band
        expect(saved[0].estimatedDelivery).toBe("9 days");
    });

    it("marks the category as carried once something actually synced", async () => {
        wire(
            [{ id: 3, name: "X", price: "2.00" }],
            { 3: [{ type: "regular", price: 3.00, estimated_delivery: "8 days" }] },
        );
        const { svc } = buildService();
        const catRepo = (svc as any).categoryRepo;

        await svc.syncCategoryPage(61);

        const savedCategory = catRepo.save.mock.calls.at(-1)[0];
        expect(savedCategory.isCarried).toBe(true);
    });

    it("leaves the category uncarried when every product was skipped", async () => {
        wire([{ id: 9, name: "Y", price: "2.00" }], {});
        const { svc } = buildService();
        const catRepo = (svc as any).categoryRepo;

        await svc.syncCategoryPage(61);

        expect(catRepo.save).not.toHaveBeenCalled();
    });

    it("handles an empty page without touching anything", async () => {
        wire([], {});
        const { svc, saved } = buildService();
        expect(await svc.syncCategoryPage(61)).toEqual({ saved: 0, skipped: 0 });
        expect(saved).toEqual([]);
    });
});

describe("syncCategories", () => {
    it("mirrors the tree, parent links included", async () => {
        mockCall.mockResolvedValue({
            categories: [
                { id: 60, name: "Animals & Pet Supplies", parent_id: null, visible_product_count: 15981 },
                { id: 45, name: "Academic Papers", parent_id: 205, visible_product_count: 65 },
            ],
        } as any);
        const svc = new CatalogSyncService();
        const saved: any[] = [];
        (svc as any).categoryRepo = {
            findOne: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockImplementation((d: any) => ({ ...d })),
            save: jest.fn().mockImplementation(async (e: any) => { saved.push({ ...e }); return e; }),
        };

        expect(await svc.syncCategories()).toBe(2);
        expect(saved[0]).toMatchObject({ zendropCategoryId: 60, parentId: null, productCount: 15981 });
        expect(saved[1]).toMatchObject({ zendropCategoryId: 45, parentId: 205, productCount: 65 });
    });
});
