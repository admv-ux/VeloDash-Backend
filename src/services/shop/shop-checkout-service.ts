import Stripe from "stripe";
import { AppDataSource } from "../../db/data-source";
import { ShopProduct } from "../../models/shop-product";
import { ShopOrder, ShopOrderStatus, ShopOrderLine } from "../../models/shop-order";
import { PlatformSettings } from "../../models/platform-settings";
import { paymentProviderRegistry } from "../payment/payment-provider-registry";
import { createServiceLogger } from "../../utils/logger";
import { In } from "typeorm";

const log = createServiceLogger("ShopCheckout");

/** A basket bigger than this is a mistake or an attack, not a shopper. */
export const MAX_LINES = 20;
export const MAX_QUANTITY_PER_LINE = 10;

export class CheckoutError extends Error {
    constructor(message: string, readonly statusCode = 400) {
        super(message);
        this.name = "CheckoutError";
    }
}

export interface CheckoutRequestLine {
    productId: string;
    quantity: number;
}

/** Money in cents end to end, so no float ever reaches a total. */
function cents(amount: number): number {
    return Math.round(Number(amount) * 100);
}

/**
 * Short, unambiguous order code. Excludes the characters people misread when
 * they read a code down the phone to support.
 */
function orderNumber(): string {
    const alphabet = "ACDEFGHJKLMNPQRTUVWXY3479";
    let out = "";
    for (let i = 0; i < 8; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
    return `VD-${out}`;
}

export class ShopCheckoutService {
    private productRepo = AppDataSource.getRepository(ShopProduct);
    private orderRepo = AppDataSource.getRepository(ShopOrder);
    private settingsRepo = AppDataSource.getRepository(PlatformSettings);

    /** Destinations checkout accepts. See the note on the settings column. */
    async allowedCountries(): Promise<string[]> {
        const settings = await this.settingsRepo.findOne({ where: {} });
        const raw = settings?.shopAllowedCountries || "US";
        const list = raw
            .split(",")
            .map((c) => c.trim().toUpperCase())
            .filter((c) => /^[A-Z]{2}$/.test(c));
        return list.length ? Array.from(new Set(list)) : ["US"];
    }

    /**
     * Price a basket from our own records.
     *
     * The client sends ids and quantities and nothing else. Prices, names and
     * stock all come from the database, because a price posted by the browser
     * is a price the shopper chose.
     */
    async quote(lines: CheckoutRequestLine[]): Promise<{ items: ShopOrderLine[]; subtotal: number }> {
        if (!Array.isArray(lines) || lines.length === 0) {
            throw new CheckoutError("Your basket is empty");
        }
        if (lines.length > MAX_LINES) {
            throw new CheckoutError(`A basket can hold at most ${MAX_LINES} different products`);
        }

        // Fold duplicates so the same product sent twice cannot slip past the
        // per line quantity cap.
        const wanted = new Map<string, number>();
        for (const line of lines) {
            const id = String(line?.productId || "").trim();
            // Rejected rather than floored: a fractional quantity means the
            // caller is confused, and quietly selling them a different number
            // of items than they asked for is not a kindness.
            const qty = Number(line?.quantity);
            if (!id) throw new CheckoutError("A basket line is missing its product");
            if (!Number.isInteger(qty) || qty < 1) {
                throw new CheckoutError("Quantity must be a whole number of at least 1");
            }
            wanted.set(id, (wanted.get(id) || 0) + qty);
        }
        for (const [id, qty] of wanted) {
            if (qty > MAX_QUANTITY_PER_LINE) {
                throw new CheckoutError(`You can order at most ${MAX_QUANTITY_PER_LINE} of any one item`, 400);
            }
            if (!/^[0-9a-f-]{36}$/i.test(id)) throw new CheckoutError("Unknown product in basket", 400);
        }

        const products = await this.productRepo.find({
            where: { id: In([...wanted.keys()]), isActive: true },
        });
        const byId = new Map(products.map((p) => [p.id, p]));

        const items: ShopOrderLine[] = [];
        let subtotalCents = 0;
        for (const [id, quantity] of wanted) {
            const p = byId.get(id);
            if (!p) throw new CheckoutError("One of the items is no longer available", 409);
            if (!p.inStock) throw new CheckoutError(`"${p.name}" is out of stock`, 409);

            const unitCents = cents(p.retailPrice);
            if (unitCents <= 0) throw new CheckoutError("One of the items is not priced", 409);
            const lineCents = unitCents * quantity;
            subtotalCents += lineCents;

            items.push({
                productId: p.id,
                zendropProductId: p.zendropProductId,
                name: p.name,
                image: p.image,
                unitPrice: unitCents / 100,
                quantity,
                lineTotal: lineCents / 100,
            });
        }

        return { items, subtotal: subtotalCents / 100 };
    }

    /**
     * Create the order and a Stripe hosted Checkout session.
     *
     * Hosted Checkout rather than Elements on purpose: Stripe collects the
     * card and the shipping address on their own page, so this site never
     * touches card data, needs no publishable key and ships no payment JS.
     */
    async createCheckout(params: {
        lines: CheckoutRequestLine[];
        email?: string;
        /** May contain {ORDER_ID}, replaced once the order row exists. */
        successUrl: string;
        cancelUrl: string;
    }): Promise<{ orderId: string; orderNumber: string; total: number; checkoutUrl: string }> {
        const { items, subtotal } = await this.quote(params.lines);
        const countries = await this.allowedCountries();

        const order = this.orderRepo.create({
            orderNumber: orderNumber(),
            email: (params.email || "").trim().toLowerCase().slice(0, 200),
            items,
            subtotal,
            shippingTotal: 0,
            total: subtotal,
            currency: "USD",
            status: ShopOrderStatus.AWAITING_PAYMENT,
        });
        await this.orderRepo.save(order);

        const stripe = paymentProviderRegistry.getStripeProvider().client;
        let session: Stripe.Checkout.Session;
        try {
            session = await stripe.checkout.sessions.create({
                mode: "payment",
                // Stripe rejects an empty string here, so only send a real one.
                ...(order.email ? { customer_email: order.email } : {}),
                line_items: items.map((i) => ({
                    quantity: i.quantity,
                    price_data: {
                        currency: "usd",
                        unit_amount: cents(i.unitPrice),
                        product_data: {
                            name: i.name.slice(0, 250),
                            ...(i.image ? { images: [i.image] } : {}),
                        },
                    },
                })),
                shipping_address_collection: { allowed_countries: countries as any },
                success_url: params.successUrl.replace("{ORDER_ID}", order.id),
                cancel_url: params.cancelUrl,
                // Both ids travel with the session: the first is what the
                // webhook looks the order up by, the second is for a human
                // reading the Stripe dashboard.
                metadata: { shopOrderId: order.id, orderNumber: order.orderNumber },
                payment_intent_data: {
                    metadata: { shopOrderId: order.id, orderNumber: order.orderNumber },
                },
                expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
            });
        } catch (e) {
            // The order row is already saved, so leave it as a dead
            // awaiting_payment record rather than pretending it never existed.
            log.error("Stripe checkout session failed", {
                orderId: order.id,
                error: (e as Error).message,
            });
            throw new CheckoutError("We could not start checkout just now. Please try again.", 502);
        }

        order.stripeSessionId = session.id;
        await this.orderRepo.save(order);

        log.info("Checkout session created", {
            orderId: order.id,
            orderNumber: order.orderNumber,
            total: order.total,
            lines: items.length,
        });

        return {
            orderId: order.id,
            orderNumber: order.orderNumber,
            total: subtotal,
            checkoutUrl: session.url || "",
        };
    }

    /**
     * Mark an order paid. Idempotent: Stripe retries webhooks, and the same
     * event arriving twice must not pay an order twice.
     */
    async markPaid(params: {
        shopOrderId: string;
        paymentIntentId?: string | null;
        amountTotal?: number | null;
        shippingAddress?: Record<string, any> | null;
        email?: string | null;
    }): Promise<ShopOrder | null> {
        const order = await this.orderRepo.findOne({ where: { id: params.shopOrderId } });
        if (!order) {
            log.warn("Paid webhook for an unknown order", { shopOrderId: params.shopOrderId });
            return null;
        }
        if (order.status === ShopOrderStatus.PAID) return order;

        // Guard against a session being paid for less than the basket cost.
        if (params.amountTotal !== undefined && params.amountTotal !== null) {
            if (cents(params.amountTotal) < cents(order.total)) {
                log.error("Paid amount is below the order total, refusing to mark paid", {
                    orderId: order.id,
                    paid: params.amountTotal,
                    expected: order.total,
                });
                return order;
            }
        }

        order.status = ShopOrderStatus.PAID;
        order.paidAt = new Date();
        if (params.paymentIntentId) order.stripePaymentIntentId = params.paymentIntentId;
        if (params.shippingAddress) order.shippingAddress = params.shippingAddress;
        if (params.email && !order.email) order.email = params.email.toLowerCase().slice(0, 200);
        await this.orderRepo.save(order);

        log.info("Shop order paid", { orderId: order.id, orderNumber: order.orderNumber });
        return order;
    }

    async markFailed(shopOrderId: string, reason?: string): Promise<void> {
        const order = await this.orderRepo.findOne({ where: { id: shopOrderId } });
        if (!order || order.status === ShopOrderStatus.PAID) return;
        order.status = ShopOrderStatus.PAYMENT_FAILED;
        order.fulfillmentError = reason ? String(reason).slice(0, 500) : null;
        await this.orderRepo.save(order);
    }

    /** The uuid is the capability token, so no further auth is needed. */
    async getOrder(id: string): Promise<ShopOrder | null> {
        if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
        return this.orderRepo.findOne({ where: { id } });
    }
}
