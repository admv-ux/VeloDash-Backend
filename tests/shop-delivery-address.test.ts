import { PaymentService } from "../src/services/payment/payment-service";
import { ShopCheckoutService } from "../src/services/shop/shop-checkout-service";
import { ShopOrderStatus } from "../src/models/shop-order";
import { toShopifyAddress } from "../src/services/shop/shopify-order-service";

/**
 * Where a shop order's delivery address comes from.
 *
 * Nowhere in our own app. The basket takes a destination country, because
 * that is what shipping is priced on, and an email, because that is where the
 * order link goes. The street address is typed on Stripe's own payment page,
 * which we ask for by setting shipping_address_collection on the session, and
 * it comes back to us on the webhook that tells us the order was paid.
 *
 * That makes the webhook the only road the address travels, so this walks the
 * whole of it: the session asks for an address, the webhook stores it on the
 * order, and the stored shape is the one the Shopify push can use. No live
 * order has completed yet, so nothing but a test has exercised this.
 */

function paymentServiceWithValidSignature() {
    const svc = new PaymentService();
    jest.spyOn(
        require("../src/services/payment/payment-provider-registry").paymentProviderRegistry,
        "getStripeProvider",
    ).mockReturnValue({ verifyWebhookSignature: () => true });
    return svc;
}

function captureMarkPaid() {
    const calls: any[] = [];
    jest.spyOn(ShopCheckoutService.prototype, "markPaid").mockImplementation(async (p: any) => {
        calls.push(p);
        return null as any;
    });
    return calls;
}

const session = (over: Record<string, any> = {}) => ({
    id: "cs_test_1",
    payment_status: "paid",
    payment_intent: "pi_1",
    amount_total: 2299,
    metadata: { shopOrderId: "11111111-1111-1111-1111-111111111111", orderNumber: "VD-TEST" },
    customer_details: { email: "buyer@example.test" },
    ...over,
});

const STRIPE_SHIPPING = {
    name: "Ama Mensah",
    address: {
        line1: "480 Lexington Ave",
        line2: "Apt 12",
        city: "New York",
        state: "NY",
        postal_code: "10017",
        country: "US",
    },
};

afterEach(() => jest.restoreAllMocks());

describe("the address is asked for on the Stripe page", () => {
    it("the checkout session restricts it to the country the basket was priced for", async () => {
        const src = require("fs").readFileSync(
            require("path").join(__dirname, "../src/services/shop/shop-checkout-service.ts"),
            "utf8",
        );
        expect(src).toContain("shipping_address_collection: { allowed_countries: [country] as any }");
    });
});

describe("the paid webhook carries it back", () => {
    it("stores the shipping details Stripe collected", async () => {
        const svc = paymentServiceWithValidSignature();
        const calls = captureMarkPaid();

        await svc.handleStripeWebhook(
            JSON.stringify({
                type: "checkout.session.completed",
                data: { object: session({ collected_information: { shipping_details: STRIPE_SHIPPING } }) },
            }),
            "sig",
        );

        expect(calls).toHaveLength(1);
        expect(calls[0].shippingAddress).toEqual(STRIPE_SHIPPING);
        expect(calls[0].email).toBe("buyer@example.test");
        expect(calls[0].shopOrderId).toBe("11111111-1111-1111-1111-111111111111");
    });

    it("still reads the older top-level shipping_details", async () => {
        const svc = paymentServiceWithValidSignature();
        const calls = captureMarkPaid();

        await svc.handleStripeWebhook(
            JSON.stringify({
                type: "checkout.session.completed",
                data: { object: session({ shipping_details: STRIPE_SHIPPING }) },
            }),
            "sig",
        );

        expect(calls[0].shippingAddress).toEqual(STRIPE_SHIPPING);
    });

    it("does nothing for a session that was not paid", async () => {
        const svc = paymentServiceWithValidSignature();
        const calls = captureMarkPaid();

        await svc.handleStripeWebhook(
            JSON.stringify({
                type: "checkout.session.completed",
                data: { object: session({ payment_status: "unpaid" }) },
            }),
            "sig",
        );

        expect(calls).toHaveLength(0);
    });
});

describe("markPaid writes it onto the order", () => {
    function order() {
        return {
            id: "11111111-1111-1111-1111-111111111111",
            orderNumber: "VD-TEST",
            status: ShopOrderStatus.AWAITING_PAYMENT,
            total: 22.99,
            email: "",
            shippingAddress: null as any,
        };
    }

    function service(row: any) {
        const svc = Object.create(ShopCheckoutService.prototype) as any;
        svc.orderRepo = { findOne: async () => row, save: async (v: any) => v };
        return svc;
    }

    it("saves the address and the email that came with the payment", async () => {
        const row = order();
        await service(row).markPaid({
            shopOrderId: row.id,
            paymentIntentId: "pi_1",
            amountTotal: 22.99,
            shippingAddress: STRIPE_SHIPPING,
            email: "Buyer@Example.test",
        });
        expect(row.status).toBe(ShopOrderStatus.PAID);
        expect(row.shippingAddress).toEqual(STRIPE_SHIPPING);
        expect(row.email).toBe("buyer@example.test");
    });

    it("leaves an underpaid order alone, address and all", async () => {
        const row = order();
        await service(row).markPaid({
            shopOrderId: row.id,
            amountTotal: 1.0,
            shippingAddress: STRIPE_SHIPPING,
        });
        expect(row.status).toBe(ShopOrderStatus.AWAITING_PAYMENT);
        expect(row.shippingAddress).toBeNull();
    });
});

describe("what Zendrop is finally given", () => {
    it("the stored Stripe shape maps to a usable Shopify address", () => {
        const a = toShopifyAddress(STRIPE_SHIPPING)!;
        expect(a).toMatchObject({
            first_name: "Ama",
            last_name: "Mensah",
            address1: "480 Lexington Ave",
            address2: "Apt 12",
            city: "New York",
            province: "NY",
            zip: "10017",
            country_code: "US",
        });
    });

    it("an order that never got one cannot be pushed", () => {
        expect(toShopifyAddress(null)).toBeNull();
    });
});
