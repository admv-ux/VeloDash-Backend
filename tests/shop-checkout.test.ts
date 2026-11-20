import { ShopCheckoutService, CheckoutError, MAX_LINES, MAX_QUANTITY_PER_LINE } from "../src/services/shop/shop-checkout-service";
import { ShopOrderStatus } from "../src/models/shop-order";

/**
 * Checkout takes ids and quantities from an anonymous browser and turns them
 * into a charge, so the only thing standing between a shopper and a price of
 * their own choosing is that prices are recomputed here.
 */
const PRODUCTS: any[] = [
    { id: "11111111-1111-1111-1111-111111111111", zendropProductId: 1, name: "Cheap thing", image: "a.webp", retailPrice: "9.99", isActive: true, inStock: true },
    { id: "22222222-2222-2222-2222-222222222222", zendropProductId: 2, name: "Dear thing", image: null, retailPrice: "74.99", isActive: true, inStock: true },
    { id: "33333333-3333-3333-3333-333333333333", zendropProductId: 3, name: "Gone thing", image: null, retailPrice: "19.99", isActive: true, inStock: false },
];

function buildService(opts: { countries?: string } = {}) {
    const svc = new ShopCheckoutService();
    const saved: any[] = [];
    (svc as any).productRepo = {
        find: jest.fn().mockImplementation(async ({ where }: any) => {
            const ids: string[] = where.id?._value || where.id?.value || [];
            return PRODUCTS.filter((p) => ids.includes(p.id) && p.isActive);
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
