import { ShopCheckoutService, CheckoutError, MAX_LINES, MAX_QUANTITY_PER_LINE } from "../src/services/shop/shop-checkout-service";
import { ShopOrderStatus } from "../src/models/shop-order";

/**
 * Checkout takes ids and quantities from an anonymous browser and turns them
 * into a charge, so the only thing standing between a shopper and a price of
 * their own choosing is that prices are recomputed here.
 */
const v = (storeVariantId: string, title: string, retail: number, inStock = true) =>
    ({ sku: null, title, storeVariantId, zendropVariantId: null, wholesale: 1, landedCost: 2, retail, image: null, inStock });

const PRODUCTS: any[] = [
    { id: "11111111-1111-1111-1111-111111111111", zendropProductId: 1, name: "Cheap thing", image: "a.webp", retailPrice: "9.99", isActive: true, isFulfillable: true, inStock: true, shippingCost: 5, shippingByCountry: {}, variants: [v("901", "Default", 9.99)] },
    { id: "22222222-2222-2222-2222-222222222222", zendropProductId: 2, name: "Dear thing", image: null, retailPrice: "74.99", isActive: true, isFulfillable: true, inStock: true, shippingCost: 5, shippingByCountry: {}, variants: [v("902", "Default", 74.99)] },
    { id: "33333333-3333-3333-3333-333333333333", zendropProductId: 3, name: "Gone thing", image: null, retailPrice: "19.99", isActive: true, isFulfillable: true, inStock: false, variants: [v("903", "Default", 19.99)] },
    // Options, so there is something real to choose wrongly.
    { id: "44444444-4444-4444-4444-444444444444", zendropProductId: 4, name: "Sized thing", image: null, retailPrice: "29.99", isActive: true, isFulfillable: true, inStock: true, shippingCost: 5, shippingByCountry: {}, variants: [v("941", "Small", 29.99), v("942", "Large", 39.99), v("943", "XL", 49.99, false)] },
    // In the store but with nothing orderable left in it.
    { id: "55555555-5555-5555-5555-555555555555", zendropProductId: 5, name: "Variantless thing", image: null, retailPrice: "14.99", isActive: true, isFulfillable: true, inStock: true, variants: [] },
];

function buildService(opts: { countries?: string } = {}) {
    const svc = new ShopCheckoutService();
    const saved: any[] = [];
    (svc as any).productRepo = {
        find: jest.fn().mockImplementation(async ({ where }: any) => {
            const ids: string[] = where.id?._value || where.id?.value || [];
            return PRODUCTS.filter((p) => ids.includes(p.id) && p.isActive && p.isFulfillable);
        }),
    };
    (svc as any).orderRepo = {
        create: jest.fn().mockImplementation((d: any) => ({ ...d })),
        save: jest.fn().mockImplementation(async (e: any) => { saved.push({ ...e }); return e; }),
        findOne: jest.fn().mockResolvedValue(null),
    };
    (svc as any).settingsRepo = {
        findOne: jest.fn().mockResolvedValue({ shopAllowedCountries: opts.countries ?? "US" }),
    };
    return { svc, saved };
}

const line = (id: string, quantity = 1) => ({ productId: id, quantity });
const CHEAP = PRODUCTS[0].id;
const DEAR = PRODUCTS[1].id;
const OOS = PRODUCTS[2].id;
const SIZED = PRODUCTS[3].id;
const NO_VARIANTS = PRODUCTS[4].id;


/**
 * Variants are where a dropshipped order goes wrong quietly: the money is
 * right, the parcel is the wrong size. The Shopify variant id is the only
 * thing Zendrop fulfils against, so these guard that it is always recorded
 * and always the one the shopper picked.
 */
describe("variants", () => {
    it("records the Shopify variant id on the line, which is what fulfilment needs", async () => {
        const { svc } = buildService();
        const q = await svc.quote([{ productId: SIZED, quantity: 1, variantId: "942" }]);
        expect(q.items[0].variantId).toBe("942");
        expect(q.items[0].variantTitle).toBe("Large");
        expect(q.items[0].unitPrice).toBe(39.99);
    });

    it("refuses to guess when a product has options and none was chosen", async () => {
        const { svc } = buildService();
        await expect(svc.quote([line(SIZED, 1)])).rejects.toThrow(/Choose an option/);
    });

    it("needs no choice when there is only one variant", async () => {
        const { svc } = buildService();
        const q = await svc.quote([line(CHEAP, 1)]);
        expect(q.items[0].variantId).toBe("901");
    });

    it("rejects a variant that does not belong to the product", async () => {
        const { svc } = buildService();
        await expect(
            svc.quote([{ productId: SIZED, quantity: 1, variantId: "901" }]),
        ).rejects.toThrow(/no longer available/);
    });

    it("rejects an out of stock variant even though the product is in stock", async () => {
        const { svc } = buildService();
        await expect(
            svc.quote([{ productId: SIZED, quantity: 1, variantId: "943" }]),
        ).rejects.toThrow(/out of stock/);
    });

    it("prices each variant on its own, not on the product's from price", async () => {
        const { svc } = buildService();
        const q = await svc.quote([
            { productId: SIZED, quantity: 1, variantId: "941" },
            { productId: SIZED, quantity: 1, variantId: "942" },
        ]);
        expect(q.items).toHaveLength(2);
        expect(q.subtotal).toBe(69.98);
    });

    it("counts two sizes of one product as two lines, not a folded duplicate", async () => {
        const { svc } = buildService();
        const q = await svc.quote([
            { productId: SIZED, quantity: 6, variantId: "941" },
            { productId: SIZED, quantity: 6, variantId: "942" },
        ]);
        expect(q.items).toHaveLength(2);
    });

    it("still folds the same variant sent twice, so the cap holds", async () => {
        const { svc } = buildService();
        await expect(
            svc.quote([
                { productId: SIZED, quantity: 6, variantId: "941" },
                { productId: SIZED, quantity: 6, variantId: "941" },
            ]),
        ).rejects.toThrow(/at most/);
    });

    it("refuses a product left with no orderable variant", async () => {
        const { svc } = buildService();
        await expect(svc.quote([line(NO_VARIANTS, 1)])).rejects.toThrow(/not available to order/);
    });

    it("rejects a malformed variant id outright", async () => {
        const { svc } = buildService();
        await expect(
            svc.quote([{ productId: SIZED, quantity: 1, variantId: "941 OR 1=1" }]),
        ).rejects.toThrow(/Unknown option/);
    });
});

describe("quote", () => {
    it("prices from our own records, ignoring anything the client sent", async () => {
        const { svc } = buildService();
        const q = await svc.quote([{ productId: CHEAP, quantity: 2, price: 0.01 } as any]);
        expect(q.items[0].unitPrice).toBe(9.99);
        expect(q.items[0].lineTotal).toBe(19.98);
        expect(q.subtotal).toBe(19.98);
    });

    it("keeps totals exact across many lines", async () => {
        const { svc } = buildService();
        const q = await svc.quote([line(CHEAP, 3), line(DEAR, 2)]);
        expect(q.subtotal).toBe(9.99 * 3 + 74.99 * 2);
        expect(q.subtotal).toBe(179.95);
    });

    it("folds a duplicated product so the quantity cap cannot be bypassed", async () => {
        const { svc } = buildService();
        await expect(
            svc.quote([line(CHEAP, 6), line(CHEAP, 6)]),
        ).rejects.toBeInstanceOf(CheckoutError);
    });

    it("sums a duplicated product rather than listing it twice", async () => {
        const { svc } = buildService();
        const q = await svc.quote([line(CHEAP, 2), line(CHEAP, 3)]);
        expect(q.items).toHaveLength(1);
        expect(q.items[0].quantity).toBe(5);
    });

    it("rejects an empty basket", async () => {
        const { svc } = buildService();
        await expect(svc.quote([])).rejects.toBeInstanceOf(CheckoutError);
    });

    it("rejects more lines than the cap", async () => {
        const { svc } = buildService();
        const many = Array.from({ length: MAX_LINES + 1 }, (_, i) =>
            line(`00000000-0000-0000-0000-${String(i).padStart(12, "0")}`),
        );
        await expect(svc.quote(many)).rejects.toBeInstanceOf(CheckoutError);
    });

    it("rejects a quantity above the per line cap", async () => {
        const { svc } = buildService();
        await expect(svc.quote([line(CHEAP, MAX_QUANTITY_PER_LINE + 1)])).rejects.toBeInstanceOf(CheckoutError);
    });

    it.each([0, -1, 1.5, NaN, "two"])("rejects quantity %p", async (q) => {
        const { svc } = buildService();
        await expect(svc.quote([{ productId: CHEAP, quantity: q as any }])).rejects.toBeInstanceOf(CheckoutError);
    });

    it("rejects an id that is not a uuid", async () => {
        const { svc } = buildService();
        await expect(svc.quote([line("'; DROP TABLE shop_products; --")])).rejects.toBeInstanceOf(CheckoutError);
    });

    it("rejects a product that is not in the catalogue", async () => {
        const { svc } = buildService();
        await expect(
            svc.quote([line("99999999-9999-9999-9999-999999999999")]),
        ).rejects.toBeInstanceOf(CheckoutError);
    });

    it("refuses to sell something out of stock", async () => {
        const { svc } = buildService();
        await expect(svc.quote([line(OOS)])).rejects.toBeInstanceOf(CheckoutError);
    });
});

describe("allowedCountries", () => {
    it("defaults to the US, because prices were built on US shipping", async () => {
        const { svc } = buildService({ countries: "" });
        expect(await svc.allowedCountries()).toEqual(["US"]);
    });

    it("parses, trims, uppercases and de-duplicates the list", async () => {
        const { svc } = buildService({ countries: "us, gb ,US,ca" });
        expect(await svc.allowedCountries()).toEqual(["US", "GB", "CA"]);
    });

    it("drops entries that are not two letter codes", async () => {
        const { svc } = buildService({ countries: "US,GBR,,x,CA" });
        expect(await svc.allowedCountries()).toEqual(["US", "CA"]);
    });
});

describe("markPaid", () => {
    function orderStub(over: any = {}) {
        return {
            id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            orderNumber: "VD-TESTTEST",
            email: "",
            total: "19.98",
            status: ShopOrderStatus.AWAITING_PAYMENT,
            paidAt: null,
            stripePaymentIntentId: null,
            shippingAddress: null,
            ...over,
        };
    }

    function withOrder(order: any) {
        const { svc } = buildService();
        const saves: any[] = [];
        (svc as any).orderRepo = {
            findOne: jest.fn().mockResolvedValue(order),
            save: jest.fn().mockImplementation(async (e: any) => { saves.push({ ...e }); return e; }),
        };
        return { svc, saves };
    }

    it("marks an awaiting order paid and stamps the payment intent", async () => {
        const { svc, saves } = withOrder(orderStub());
        await svc.markPaid({
            shopOrderId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            paymentIntentId: "pi_123",
            amountTotal: 19.98,
            email: "Buyer@Example.com",
        });
        expect(saves).toHaveLength(1);
        expect(saves[0].status).toBe(ShopOrderStatus.PAID);
        expect(saves[0].stripePaymentIntentId).toBe("pi_123");
        expect(saves[0].email).toBe("buyer@example.com");
        expect(saves[0].paidAt).toBeInstanceOf(Date);
    });

    it("is idempotent, because Stripe retries webhooks", async () => {
        const { svc, saves } = withOrder(orderStub({ status: ShopOrderStatus.PAID }));
        await svc.markPaid({ shopOrderId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", amountTotal: 19.98 });
        expect(saves).toHaveLength(0);
    });

    it("refuses to mark paid when less than the total was collected", async () => {
        const { svc, saves } = withOrder(orderStub());
        await svc.markPaid({ shopOrderId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", amountTotal: 5.0 });
        expect(saves).toHaveLength(0);
    });

    it("accepts an overpayment rather than stranding a paid order", async () => {
        const { svc, saves } = withOrder(orderStub());
        await svc.markPaid({ shopOrderId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", amountTotal: 25.0 });
        expect(saves[0].status).toBe(ShopOrderStatus.PAID);
    });

    it("does nothing for an order id it does not know", async () => {
        const { svc, saves } = withOrder(null);
        const result = await svc.markPaid({ shopOrderId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" });
        expect(result).toBeNull();
        expect(saves).toHaveLength(0);
    });

    it("does not keep an existing email from being overwritten by a blank one", async () => {
        const { svc, saves } = withOrder(orderStub({ email: "first@example.com" }));
        await svc.markPaid({ shopOrderId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", email: "second@example.com" });
        expect(saves[0].email).toBe("first@example.com");
    });
});

describe("markFailed", () => {
    it("never un-pays an order that already settled", async () => {
        const svc = new ShopCheckoutService();
        const saves: any[] = [];
        (svc as any).orderRepo = {
            findOne: jest.fn().mockResolvedValue({ id: "x", status: ShopOrderStatus.PAID }),
            save: jest.fn().mockImplementation(async (e: any) => { saves.push(e); return e; }),
        };
        await svc.markFailed("x", "checkout.session.expired");
        expect(saves).toHaveLength(0);
    });

    it("marks an unpaid order failed with the reason", async () => {
        const svc = new ShopCheckoutService();
        const saves: any[] = [];
        (svc as any).orderRepo = {
            findOne: jest.fn().mockResolvedValue({ id: "x", status: ShopOrderStatus.AWAITING_PAYMENT }),
            save: jest.fn().mockImplementation(async (e: any) => { saves.push({ ...e }); return e; }),
        };
        await svc.markFailed("x", "checkout.session.expired");
        expect(saves[0].status).toBe(ShopOrderStatus.PAYMENT_FAILED);
        expect(saves[0].fulfillmentError).toBe("checkout.session.expired");
    });
});

describe("getOrder", () => {
    it("rejects an id that is not a uuid without touching the database", async () => {
        const svc = new ShopCheckoutService();
        const findOne = jest.fn();
        (svc as any).orderRepo = { findOne };
        expect(await svc.getOrder("../../etc/passwd")).toBeNull();
        expect(findOne).not.toHaveBeenCalled();
    });
});

/**
 * Destination pricing. Retail prices carry US shipping, so anywhere dearer
 * has to add the difference or the order ships below its landed cost. Real
 * measurements behind these numbers: a graphite case is $4.58 to the US and
 * $12.39 to Australia, while a leather jacket is $44.77 to the US and $22.49
 * to Britain.
 */
describe("destination pricing", () => {
    const withShipping = (quotes: Record<string, any>) => {
        const { svc, saved } = buildService({ countries: "US,GB,AU" });
        (svc as any).shipping = {
            quoteMany: jest.fn(async (products: any[]) =>
                new Map(products.map((p) => [p.id, quotes[p.id] ?? quotes["*"] ?? null]))),
            surchargePerUnit: (p: any, q: any) => {
                const d = q.cost - (Number(p.shippingCost) || 0);
                return d > 0 ? Math.round(d * 100) / 100 : 0;
            },
        };
        return { svc, saved };
    };

    it("adds nothing for the baseline market", async () => {
        const { svc } = withShipping({ "*": { cost: 99, eta: null } });
        const q = await svc.quote([line(CHEAP, 1)], "US");
        expect(q.shippingTotal).toBe(0);
        expect(q.total).toBe(q.subtotal);
    });

    it("charges the difference, multiplied by quantity", async () => {
        const { svc } = withShipping({ "*": { cost: 12.39, eta: null } });
        const q = await svc.quote([line(CHEAP, 3)], "AU");
        expect(q.shippingTotal).toBeCloseTo(7.39 * 3, 2);
        expect(q.total).toBeCloseTo(q.subtotal + 7.39 * 3, 2);
    });

    it("charges nothing where the destination is cheaper than the US", async () => {
        const { svc } = withShipping({ "*": { cost: 2.5, eta: null } });
        const q = await svc.quote([line(CHEAP, 2)], "GB");
        expect(q.shippingTotal).toBe(0);
    });

    it("names every blocked item at once, not the first one it hits", async () => {
        const { svc } = withShipping({});
        await expect(svc.quote([line(CHEAP, 1), line(DEAR, 1)], "GB"))
            .rejects.toThrow(/2 items cannot be shipped/);
    });

    it("names the single blocked item on its own", async () => {
        const { svc } = withShipping({ [DEAR]: { cost: 6, eta: null } });
        await expect(svc.quote([line(CHEAP, 1), line(DEAR, 1)], "GB"))
            .rejects.toThrow(/"Cheap thing" cannot be shipped/);
    });

    it("refuses a country we do not deliver to", async () => {
        const { svc } = buildService({ countries: "US,GB" });
        await expect(svc.resolveCountry("ZW")).rejects.toThrow(/do not deliver/);
    });

    it("refuses a malformed country rather than guessing", async () => {
        const { svc } = buildService({ countries: "US,GB" });
        // Falls back to the baseline, which is allowed, instead of passing
        // junk to Stripe's allowed_countries.
        await expect(svc.resolveCountry("'; DROP TABLE--")).resolves.toBe("US");
    });

    it("accepts a country we do deliver to, in any case", async () => {
        const { svc } = buildService({ countries: "US,GB" });
        await expect(svc.resolveCountry("gb")).resolves.toBe("GB");
    });
});
