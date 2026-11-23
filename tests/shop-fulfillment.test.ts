import {
    ShopifyOrderService, ShopifyError, ShopifyNotConfiguredError, toShopifyAddress,
} from "../src/services/shop/shopify-order-service";
import {
    ZendropFulfillmentService, FulfillmentError,
} from "../src/services/shop/zendrop-fulfillment-service";
import { ShopOrderStatus, ShopFulfillmentStatus } from "../src/models/shop-order";

/**
 * Fulfilment is where a shop order stops being a database row and starts
 * costing real money. Two facts from Zendrop's live API shape everything
 * tested here:
 *
 *   1. There is no create_order tool, so an order reaches the supplier only
 *      by being written into the connected Shopify store first.
 *   2. fulfill_order with a store_id and no order_ids targets EVERY
 *      unfulfilled order in the store. The test that an explicit order_ids is
 *      always sent is the one that stops a single click emptying the account.
 */

const ADDRESS = {
    name: "Ama Mensah",
    address: { line1: "12 Oxford St", line2: "Flat 4", city: "Accra", state: "GA", postal_code: "00233", country: "gh" },
};

const order = (over: any = {}) => ({
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    orderNumber: "VD-TESTTEST",
    email: "buyer@example.com",
    currency: "USD",
    status: ShopOrderStatus.PAID,
    fulfillmentStatus: ShopFulfillmentStatus.NOT_STARTED,
    shippingCountry: "GH",
    shippingTotal: 0,
    total: 25.57,
    stripePaymentIntentId: "pi_123",
    shippingAddress: ADDRESS,
    shopifyOrderId: null,
    shopifyOrderName: null,
    zendropOrderId: null,
    fulfilledAt: null,
    tracking: [],
    items: [{
        productId: "p1", zendropProductId: 7, variantId: "68120006983773", variantTitle: "Red",
        name: "Oil box", image: null, unitPrice: 23.99, quantity: 1, lineTotal: 23.99,
    }],
    ...over,
});

/** A ShopifyOrderService whose HTTP layer is captured rather than sent. */
function shopifySvc(response: any = { order: { id: 5551212, name: "#1004" } }, ok = true) {
    const svc = new ShopifyOrderService();
    const sent: any[] = [];
    (svc as any).request = jest.fn(async (path: string, body: any) => {
        sent.push({ path, body });
        if (!ok) throw new ShopifyError("Shopify responded 422", 422);
        return response;
    });
    return { svc, sent };
}

/** A fulfilment service with a fake repo and a captured Zendrop transport. */
function fulfilSvc(row: any, zendrop: (tool: string, args: any) => any) {
    const svc = new ZendropFulfillmentService();
    const state = { row: { ...row } };
    const calls: { tool: string; args: any }[] = [];
    (svc as any).orderRepo = {
        findOne: jest.fn(async () => (state.row ? { ...state.row } : null)),
        save: jest.fn(async (e: any) => { state.row = { ...state.row, ...e }; return { ...state.row }; }),
    };
    jest.spyOn(require("../src/services/shop/zendrop-client"), "zendropConfigured").mockReturnValue(true);
    jest.spyOn(require("../src/services/shop/zendrop-client"), "callZendropTool")
        .mockImplementation(async (tool: any, args: any) => { calls.push({ tool, args }); return zendrop(tool, args); });
    return { svc, state, calls };
}

afterEach(() => jest.restoreAllMocks());

describe("toShopifyAddress", () => {
    it("flattens Stripe's nested shipping_details", () => {
        const a = toShopifyAddress(ADDRESS)!;
        expect(a).toMatchObject({
            first_name: "Ama", last_name: "Mensah", address1: "12 Oxford St",
            address2: "Flat 4", city: "Accra", province: "GA", zip: "00233", country_code: "GH",
        });
    });

    it("accepts an already flat address", () => {
        const a = toShopifyAddress({ name: "Kofi", address1: "1 High St", city: "Tema", zip: "233", country: "GH" })!;
        expect(a.address1).toBe("1 High St");
        expect(a.country_code).toBe("GH");
    });

    it("keeps a single word name whole rather than blanking it", () => {
        // Shopify rejects an order with no name on the address, and plenty of
        // people enter one word.
        const a = toShopifyAddress({ name: "Prince", address: { line1: "x", country: "GH" } })!;
        expect(a.first_name).toBe("Prince");
        expect(a.last_name).toBe("");
    });

    it("keeps every part of a three part name", () => {
        const a = toShopifyAddress({ name: "Mary Jane Watson", address: { line1: "x", country: "US" } })!;
        expect(a.first_name).toBe("Mary Jane");
        expect(a.last_name).toBe("Watson");
    });

    it("falls back to a placeholder when there is no name at all", () => {
        const a = toShopifyAddress({ address: { line1: "x", country: "US" } })!;
        expect(a.first_name).toBe("Customer");
    });

    it("is null for no address", () => {
        expect(toShopifyAddress(null)).toBeNull();
    });
});

describe("ShopifyOrderService.createOrder", () => {
    it("sends the variant as a number, because Shopify rejects a string id", async () => {
        const { svc, sent } = shopifySvc();
        await svc.createOrder(order() as any);
        expect(sent[0].body.order.line_items[0].variant_id).toBe(68120006983773);
        expect(typeof sent[0].body.order.line_items[0].variant_id).toBe("number");
    });

    it("suppresses both Shopify receipts", async () => {
        // The customer bought on shopvelodash.com. A receipt from an unknown
        // myshopify.com address reads as a phishing attempt.
        const { svc, sent } = shopifySvc();
        await svc.createOrder(order() as any);
        expect(sent[0].body.order.send_receipt).toBe(false);
        expect(sent[0].body.order.send_fulfillment_receipt).toBe(false);
    });

    it("marks the order paid with a matching transaction", async () => {
        const { svc, sent } = shopifySvc();
        await svc.createOrder(order({ total: 51.14 }) as any);
        expect(sent[0].body.order.financial_status).toBe("paid");
        expect(sent[0].body.order.transactions[0]).toMatchObject({ kind: "sale", status: "success", amount: "51.14" });
    });

    it("bypasses inventory, since dropshipped variants are untracked", async () => {
        const { svc, sent } = shopifySvc();
        await svc.createOrder(order() as any);
        expect(sent[0].body.order.inventory_behaviour).toBe("bypass");
    });

    it("adds a shipping line only when the destination was charged for one", async () => {
        const { svc, sent } = shopifySvc();
        await svc.createOrder(order({ shippingTotal: 6.58, shippingCountry: "AU" }) as any);
        expect(sent[0].body.order.shipping_lines).toHaveLength(1);
        expect(sent[0].body.order.shipping_lines[0].price).toBe("6.58");

        const b = shopifySvc();
        await b.svc.createOrder(order({ shippingTotal: 0 }) as any);
        expect(b.sent[0].body.order.shipping_lines).toHaveLength(0);
    });

    it("carries our order number into the note so the two systems can be reconciled", async () => {
        const { svc, sent } = shopifySvc();
        await svc.createOrder(order() as any);
        expect(sent[0].body.order.note).toContain("VD-TESTTEST");
    });

    it("returns Shopify's own order name, which is the only Zendrop search key", async () => {
        const { svc } = shopifySvc({ order: { id: 42, name: "#1009" } });
        await expect(svc.createOrder(order() as any)).resolves.toEqual({ id: "42", name: "#1009" });
    });

    it("refuses an order with no items", async () => {
        const { svc } = shopifySvc();
        await expect(svc.createOrder(order({ items: [] }) as any)).rejects.toThrow(/no items/i);
    });

    it("refuses a line with no store variant, naming it", async () => {
        const { svc } = shopifySvc();
        const bad = order({ items: [{ ...order().items[0], variantId: null, name: "Mystery mug" }] });
        await expect(svc.createOrder(bad as any)).rejects.toThrow(/Mystery mug/);
    });

    it("refuses a non numeric variant id rather than sending NaN", async () => {
        const { svc } = shopifySvc();
        const bad = order({ items: [{ ...order().items[0], variantId: "gid://shopify/Variant/9" }] });
        await expect(svc.createOrder(bad as any)).rejects.toThrow(/No store variant/);
    });

    it("refuses an order with no usable address", async () => {
        const { svc } = shopifySvc();
        await expect(svc.createOrder(order({ shippingAddress: null }) as any)).rejects.toThrow(/delivery address/i);
        await expect(svc.createOrder(order({ shippingAddress: { name: "X", address: { country: "US" } } }) as any))
            .rejects.toThrow(/delivery address/i);
    });

    it("throws not-configured when there is no admin token", async () => {
        const prev = process.env.SHOPIFY_ADMIN_TOKEN;
        delete process.env.SHOPIFY_ADMIN_TOKEN;
        try {
            await expect(new ShopifyOrderService().createOrder(order() as any))
                .rejects.toBeInstanceOf(ShopifyNotConfiguredError);
        } finally {
            if (prev) process.env.SHOPIFY_ADMIN_TOKEN = prev;
        }
    });

    it("fails loudly when Shopify answers without an order id", async () => {
        const { svc } = shopifySvc({ order: {} });
        await expect(svc.createOrder(order() as any)).rejects.toThrow(/did not return an order id/);
    });
});

describe("sameOrderNumber", () => {
    it("treats #1004 and 1004 as one order", () => {
        expect(ZendropFulfillmentService.sameOrderNumber("#1004", "1004")).toBe(true);
        expect(ZendropFulfillmentService.sameOrderNumber(1004, "#1004")).toBe(true);
    });

    it("does not match a different order or an empty one", () => {
        expect(ZendropFulfillmentService.sameOrderNumber("#1004", "#10040")).toBe(false);
        expect(ZendropFulfillmentService.sameOrderNumber("", "")).toBe(false);
        expect(ZendropFulfillmentService.sameOrderNumber(null, undefined)).toBe(false);
    });
});

describe("mapStatus", () => {
    it("maps every label Zendrop can return", () => {
        expect(ZendropFulfillmentService.mapStatus("Unfulfilled")).toBe(ShopFulfillmentStatus.PUSHED_TO_STORE);
        expect(ZendropFulfillmentService.mapStatus("Processing")).toBe(ShopFulfillmentStatus.FULFILLING);
        expect(ZendropFulfillmentService.mapStatus("Shipped")).toBe(ShopFulfillmentStatus.SHIPPED);
        expect(ZendropFulfillmentService.mapStatus("Delivered")).toBe(ShopFulfillmentStatus.DELIVERED);
        expect(ZendropFulfillmentService.mapStatus("Canceled")).toBe(ShopFulfillmentStatus.FAILED);
    });

    it("returns null for anything unknown, so a new label never overwrites a real status", () => {
        expect(ZendropFulfillmentService.mapStatus("Quoting")).toBeNull();
        expect(ZendropFulfillmentService.mapStatus(undefined)).toBeNull();
    });
});

describe("extractTracking", () => {
    it("dedupes one number shared by several lines", () => {
        const t = ZendropFulfillmentService.extractTracking({
            line_items: [
                { tracking: [{ tracking_number: "LP1", carrier: "YunExpress" }] },
                { tracking: [{ tracking_number: "LP1", carrier: "YunExpress" }] },
            ],
        });
        expect(t).toEqual([{ number: "LP1", carrier: "YunExpress", url: null }]);
    });

    it("keeps both numbers of a split shipment", () => {
        const t = ZendropFulfillmentService.extractTracking({
            line_items: [
                { tracking: [{ tracking_number: "LP1" }] },
                { tracking: [{ tracking_number: "LP2", tracking_url: "http://t/LP2" }] },
            ],
        });
        expect(t.map((x) => x.number)).toEqual(["LP1", "LP2"]);
        expect(t[1].url).toBe("http://t/LP2");
    });

    it("reads a flat tracking_number on the line itself", () => {
        const t = ZendropFulfillmentService.extractTracking({
            line_items: [{ tracking_number: "LP9", tracking_company: "DHL" }],
        });
        expect(t).toEqual([{ number: "LP9", carrier: "DHL", url: null }]);
    });

    it("is empty before the parcel moves", () => {
        expect(ZendropFulfillmentService.extractTracking({ line_items: [{}] })).toEqual([]);
        expect(ZendropFulfillmentService.extractTracking(null)).toEqual([]);
    });
});

describe("pushToStore", () => {
    it("refuses an order that has not been paid", async () => {
        const { svc } = fulfilSvc(order({ status: ShopOrderStatus.AWAITING_PAYMENT }), () => ({}));
        await expect(svc.pushToStore(order().id)).rejects.toThrow(/paid order/i);
    });

    it("is idempotent once pushed, so a double click cannot duplicate the order", async () => {
        const { svc } = fulfilSvc(order({ shopifyOrderId: "5551212" }), () => ({}));
        const create = jest.fn();
        (svc as any).shopify = { createOrder: create };
        await svc.pushToStore(order().id);
        expect(create).not.toHaveBeenCalled();
    });

    it("answers 503 when Shopify is not configured, not 500", async () => {
        const prev = process.env.SHOPIFY_ADMIN_TOKEN;
        delete process.env.SHOPIFY_ADMIN_TOKEN;
        try {
            const { svc } = fulfilSvc(order(), () => ({}));
            await expect(svc.pushToStore(order().id)).rejects.toMatchObject({ statusCode: 503 });
        } finally {
            if (prev) process.env.SHOPIFY_ADMIN_TOKEN = prev;
        }
    });

    it("records the id, the name and the new status", async () => {
        process.env.SHOPIFY_ADMIN_TOKEN = "shpat_test";
        const { svc, state } = fulfilSvc(order(), () => ({}));
        (svc as any).shopify = { createOrder: async () => ({ id: "5551212", name: "#1004" }) };
        await svc.pushToStore(order().id);
        expect(state.row.shopifyOrderId).toBe("5551212");
        expect(state.row.shopifyOrderName).toBe("#1004");
        expect(state.row.fulfillmentStatus).toBe(ShopFulfillmentStatus.PUSHED_TO_STORE);
        delete process.env.SHOPIFY_ADMIN_TOKEN;
    });

    it("records the failure on the order and still rethrows", async () => {
        // A paid order whose push failed must be visibly broken, not silently
        // sitting in not_started looking like it was never attempted.
        process.env.SHOPIFY_ADMIN_TOKEN = "shpat_test";
        const { svc, state } = fulfilSvc(order(), () => ({}));
        (svc as any).shopify = { createOrder: async () => { throw new Error("Shopify responded 422"); } };
        await expect(svc.pushToStore(order().id)).rejects.toThrow(/422/);
        expect(state.row.fulfillmentStatus).toBe(ShopFulfillmentStatus.FAILED);
        expect(state.row.fulfillmentError).toContain("422");
        delete process.env.SHOPIFY_ADMIN_TOKEN;
    });
});

describe("linkZendropOrder", () => {
    it("refuses before the order exists in the store", async () => {
        const { svc } = fulfilSvc(order(), () => ({}));
        await expect(svc.linkZendropOrder(order().id)).rejects.toThrow(/pushed to the store/i);
    });

    it("stays unlinked, without error, while Zendrop has not ingested it", async () => {
        // Ingestion is not instant. A miss here is normal and gets retried.
        const { svc, state } = fulfilSvc(order({ shopifyOrderName: "#1004" }), () => ({ orders: [] }));
        const out = await svc.linkZendropOrder(order().id);
        expect(out.zendropOrderId).toBeNull();
        expect(state.row.fulfillmentError).toBeUndefined();
    });

    it("links on the matching order number and maps the status", async () => {
        const { svc, state } = fulfilSvc(order({ shopifyOrderName: "#1004" }),
            () => ({ orders: [{ id: 77, order_number: "1004", status: "Unfulfilled" }] }));
        const out = await svc.linkZendropOrder(order().id);
        expect(out.zendropOrderId).toBe(77);
        expect(state.row.zendropStatus).toBe("Unfulfilled");
        expect(state.row.fulfillmentStatus).toBe(ShopFulfillmentStatus.PUSHED_TO_STORE);
    });

    it("ignores a near miss rather than linking the wrong order", async () => {
        const { svc } = fulfilSvc(order({ shopifyOrderName: "#1004" }),
            () => ({ orders: [{ id: 88, order_number: "10040", status: "Unfulfilled" }] }));
        const out = await svc.linkZendropOrder(order().id);
        expect(out.zendropOrderId).toBeNull();
    });

    it("does not call Zendrop again once linked", async () => {
        const { svc, calls } = fulfilSvc(order({ shopifyOrderName: "#1004", zendropOrderId: 77 }), () => ({ orders: [] }));
        await svc.linkZendropOrder(order().id);
        expect(calls).toHaveLength(0);
    });
});

describe("fulfill", () => {
    const linked = (over: any = {}) => order({ shopifyOrderName: "#1004", zendropOrderId: 77, ...over });
    const zendrop = (tool: string) => {
        if (tool === "get_order_fulfillment_cost") return { total: 12.4, currency: "USD" };
        if (tool === "fulfill_order") return { operation_id: "op_1" };
        return {};
    };

    it("ALWAYS names the order, because an omitted order_ids fulfils the whole store", async () => {
        const { svc, calls } = fulfilSvc(linked(), zendrop);
        await svc.fulfill(order().id, { confirm: true });
        const call = calls.find((c) => c.tool === "fulfill_order")!;
        expect(call.args.order_ids).toEqual([77]);
        expect(call.args.store_id).toBeGreaterThan(0);
    });

    it("charges nothing without confirm, and returns the cost", async () => {
        const { svc, calls, state } = fulfilSvc(linked(), zendrop);
        const out = await svc.fulfill(order().id, { confirm: false });
        expect(out.dispatched).toBe(false);
        expect(out.preview.total).toBe(12.4);
        expect(calls.some((c) => c.tool === "fulfill_order")).toBe(false);
        expect(state.row.fulfilledAt).toBeNull();
    });

    it("previews before confirming, as Zendrop's handshake requires", async () => {
        const { svc, calls } = fulfilSvc(linked(), zendrop);
        await svc.fulfill(order().id, { confirm: true });
        expect(calls.map((c) => c.tool)).toEqual(["get_order_fulfillment_cost", "fulfill_order"]);
    });

    it("uses the same credit flag in both steps, or Zendrop rejects the confirmation", async () => {
        const { svc, calls } = fulfilSvc(linked(), zendrop);
        await svc.fulfill(order().id, { confirm: true, useCredits: true });
        expect(calls[0].args.is_credit_redeem).toBe(true);
        expect(calls[1].args.is_credit_redeem).toBe(true);
    });

    it("records the dispatch, the cost and the time", async () => {
        const { svc, state } = fulfilSvc(linked(), zendrop);
        const out = await svc.fulfill(order().id, { confirm: true });
        expect(out.operationId).toBe("op_1");
        expect(state.row.fulfillmentStatus).toBe(ShopFulfillmentStatus.FULFILLING);
        expect(state.row.fulfillmentCost).toBe(12.4);
        expect(state.row.fulfilledAt).toBeInstanceOf(Date);
    });

    it("refuses to spend money on an order that is not paid", async () => {
        const { svc, calls } = fulfilSvc(linked({ status: ShopOrderStatus.AWAITING_PAYMENT }), zendrop);
        await expect(svc.fulfill(order().id, { confirm: true })).rejects.toThrow(/not paid/i);
        expect(calls).toHaveLength(0);
    });

    it("refuses to fulfil the same order twice", async () => {
        const { svc, calls } = fulfilSvc(linked({ fulfilledAt: new Date() }), zendrop);
        await expect(svc.fulfill(order().id, { confirm: true })).rejects.toThrow(/already been fulfilled/i);
        expect(calls).toHaveLength(0);
    });

    it("refuses before Zendrop has picked the order up", async () => {
        const { svc } = fulfilSvc(order({ shopifyOrderName: "#1004" }), zendrop);
        await expect(svc.fulfill(order().id, { confirm: true })).rejects.toThrow(/picked this order up/i);
    });

    it("is 404 for an unknown or malformed id", async () => {
        const svc = new ZendropFulfillmentService();
        (svc as any).orderRepo = { findOne: jest.fn(async () => null) };
        await expect(svc.fulfill("not-a-uuid", { confirm: false })).rejects.toMatchObject({ statusCode: 404 });
    });
});

describe("refresh", () => {
    it("stores the status, the tracking and the real cost", async () => {
        const { svc, state } = fulfilSvc(order({ zendropOrderId: 77 }), () => ({
            status: "Shipped",
            total_cost: 11.2,
            line_items: [{ tracking: [{ tracking_number: "LP1", carrier: "YunExpress" }] }],
        }));
        const out = await svc.refresh(order().id);
        expect(out.fulfillmentStatus).toBe(ShopFulfillmentStatus.SHIPPED);
        expect(state.row.tracking).toEqual([{ number: "LP1", carrier: "YunExpress", url: null }]);
        expect(state.row.fulfillmentCost).toBe(11.2);
    });

    it("keeps the tracking it already has when a refresh returns none", async () => {
        const existing = [{ number: "LP1", carrier: null, url: null }];
        const { svc, state } = fulfilSvc(order({ zendropOrderId: 77, tracking: existing }),
            () => ({ status: "Shipped", line_items: [{}] }));
        await svc.refresh(order().id);
        expect(state.row.tracking).toEqual(existing);
    });

    it("leaves the status alone when Zendrop sends a label we do not know", async () => {
        const { svc, state } = fulfilSvc(
            order({ zendropOrderId: 77, fulfillmentStatus: ShopFulfillmentStatus.FULFILLING }),
            () => ({ status: "In review" }));
        await svc.refresh(order().id);
        expect(state.row.fulfillmentStatus).toBe(ShopFulfillmentStatus.FULFILLING);
        expect(state.row.zendropStatus).toBe("In review");
    });
});
