import { AppDataSource } from "../src/db/data-source";
import { ProductService, MERCHANT_LISTABLE_CATEGORIES } from "../src/services/product-service";

/**
 * Velo accepts food, grocery and pharmacy listings and nothing else.
 *
 * The seller app stopped offering general merchandise and services, but the
 * screen is only the door: the rule has to hold at the service, or anyone
 * posting straight to the API can still list a television. These tests drive
 * createProduct with a stubbed transaction so the gate is exercised without
 * a database.
 */

type Row = { slug: string; type?: string; isActive?: boolean } | null;

function harness(existingCategory: Row) {
    const saved: any[] = [];
    const created: any[] = [];
    const manager = {
        getRepository: (entity: any) => {
            const name = entity?.name || "";
            if (name === "ProductCategory") {
                return {
                    findOne: async () => existingCategory,
                    create: (v: any) => { created.push(v); return v; },
                    save: async (v: any) => v,
                };
            }
            if (name === "MerchantProfile") {
                return { findOne: async () => ({ address: "12 Oxford St, Accra" }) };
            }
            if (name === "MerchantStats") {
                return { findOne: async () => null, create: (v: any) => v, save: async (v: any) => v, increment: async () => undefined };
            }
            // Product, customizations, options
            return {
                create: (v: any) => v,
                save: async (v: any) => { saved.push(v); return { id: "p1", ...v }; },
                findOne: async () => null,
            };
        },
    };

    const original = (AppDataSource as any).transaction;
    (AppDataSource as any).transaction = async (fn: any) => fn(manager);

    const svc = Object.create(ProductService.prototype) as any;
    svc.getProductById = async () => ({ id: "p1" });
    svc.incrementProductCount = async () => undefined;

    return { svc, saved, created, restore: () => { (AppDataSource as any).transaction = original; } };
}

const input = (category: string) => ({
    name: "Tin of milk",
    category,
    categoryType: "marketplace" as const,
    price: 12,
    stockQuantity: 4,
    images: ["https://example.test/a.jpg"],
});

describe("what a merchant is allowed to list", () => {
    it("accepts a food category", async () => {
        const h = harness({ slug: "food", type: "marketplace", isActive: true });
        try {
            await h.svc.createProduct("m1", input("food"));
            expect(h.saved.length).toBeGreaterThan(0);
        } finally {
            h.restore();
        }
    });

    it("accepts every category the seller app offers", async () => {
        for (const category of MERCHANT_LISTABLE_CATEGORIES) {
            const h = harness(null);
            try {
                await expect(h.svc.createProduct("m1", input(category))).resolves.toBeDefined();
            } finally {
                h.restore();
            }
        }
    });

    it.each(["electronics", "fashion", "marketplace", "other", "tutoring", "rentals"])(
        "refuses general merchandise: %s",
        async (category) => {
            const h = harness({ slug: category, type: "marketplace", isActive: true });
            try {
                await expect(h.svc.createProduct("m1", input(category))).rejects.toThrow(
                    /only accepts food, grocery and pharmacy/i,
                );
                expect(h.saved).toHaveLength(0);
            } finally {
                h.restore();
            }
        },
    );

    it.each(["cleaning", "haircut", "nails", "tech-repair", "services"])(
        "refuses a service: %s",
        async (category) => {
            const h = harness({ slug: category, type: "service", isActive: true });
            try {
                await expect(h.svc.createProduct("m1", input(category))).rejects.toThrow(
                    /only accepts food, grocery and pharmacy/i,
                );
            } finally {
                h.restore();
            }
        },
    );

    it("refuses whatever casing or padding the caller sends", async () => {
        for (const category of ["Electronics", "  FASHION ", "Tech-Repair"]) {
            const h = harness(null);
            try {
                await expect(h.svc.createProduct("m1", input(category))).rejects.toThrow(/only accepts/i);
            } finally {
                h.restore();
            }
        }
    });

    it("takes an allowed category whatever its casing", async () => {
        const h = harness({ slug: "pharmacy", type: "marketplace", isActive: true });
        try {
            await expect(h.svc.createProduct("m1", input("Pharmacy"))).resolves.toBeDefined();
        } finally {
            h.restore();
        }
    });

    it("refuses an allowed category the admin has switched off", async () => {
        const h = harness({ slug: "dairy", type: "marketplace", isActive: false });
        try {
            await expect(h.svc.createProduct("m1", input("dairy"))).rejects.toThrow(/not open for new listings/i);
        } finally {
            h.restore();
        }
    });

    it("never auto-creates a category outside the list", async () => {
        const h = harness(null);
        try {
            await expect(h.svc.createProduct("m1", input("drone photography"))).rejects.toThrow(/only accepts/i);
            expect(h.created).toHaveLength(0);
        } finally {
            h.restore();
        }
    });

    it("lets the admin dashboard list outside it, because that is the admin's call", async () => {
        const h = harness({ slug: "electronics", type: "marketplace", isActive: true });
        try {
            await expect(
                h.svc.createProduct("m1", input("electronics"), { allowAnyCategory: true }),
            ).resolves.toBeDefined();
        } finally {
            h.restore();
        }
    });

    it("lists the three buckets the seller app shows, and nothing else", () => {
        expect([...MERCHANT_LISTABLE_CATEGORIES].sort()).toEqual([
            "bakery", "beauty & skincare", "beverages", "catering", "dairy",
            "food", "fresh produce", "frozen", "grocery", "medical supplies",
            "pharmacy", "supplements",
        ]);
    });
});
