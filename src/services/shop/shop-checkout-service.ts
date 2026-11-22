import Stripe from "stripe";
import { AppDataSource } from "../../db/data-source";
import { ShopProduct, ShopProductVariant } from "../../models/shop-product";
import { ShopOrder, ShopOrderStatus, ShopOrderLine } from "../../models/shop-order";
import { PlatformSettings } from "../../models/platform-settings";
import { paymentProviderRegistry } from "../payment/payment-provider-registry";
import { createServiceLogger } from "../../utils/logger";
import { In } from "typeorm";
import { ShippingQuoteService, BASELINE_COUNTRY } from "./shipping-quote-service";

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
    /**
     * Shopify variant id. Optional only for a product with exactly one
     * variant, where there is nothing to choose; anything with options must
     * say which one, because guessing a size is worse than refusing.
     */
    variantId?: string;
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
    private shipping = new ShippingQuoteService();

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
    async quote(
        lines: CheckoutRequestLine[],
        country: string = BASELINE_COUNTRY,
    ): Promise<{ items: ShopOrderLine[]; subtotal: number; shippingTotal: number; total: number; country: string }> {
        if (!Array.isArray(lines) || lines.length === 0) {
            throw new CheckoutError("Your basket is empty");
        }
        if (lines.length > MAX_LINES) {
            throw new CheckoutError(`A basket can hold at most ${MAX_LINES} different products`);
        }

        // Fold duplicates so the same item sent twice cannot slip past the per
        // line quantity cap. The key is product AND variant: two sizes of the
        // same shirt are two different things to pick, pack and ship.
        const wanted = new Map<string, { productId: string; variantId: string | null; quantity: number }>();
        for (const line of lines) {
            const id = String(line?.productId || "").trim();
            const variantId = String(line?.variantId || "").trim() || null;
            // Rejected rather than floored: a fractional quantity means the
            // caller is confused, and quietly selling them a different number
            // of items than they asked for is not a kindness.
            const qty = Number(line?.quantity);
            if (!id) throw new CheckoutError("A basket line is missing its product");
            if (!Number.isInteger(qty) || qty < 1) {
                throw new CheckoutError("Quantity must be a whole number of at least 1");
            }
            if (variantId && !/^[0-9]{1,32}$/.test(variantId)) {
                throw new CheckoutError("Unknown option in basket", 400);
            }
            const key = `${id}::${variantId || ""}`;
            const prev = wanted.get(key);
            if (prev) prev.quantity += qty;
            else wanted.set(key, { productId: id, variantId, quantity: qty });
        }
        for (const line of wanted.values()) {
            if (line.quantity > MAX_QUANTITY_PER_LINE) {
                throw new CheckoutError(`You can order at most ${MAX_QUANTITY_PER_LINE} of any one item`, 400);
            }
            if (!/^[0-9a-f-]{36}$/i.test(line.productId)) {
                throw new CheckoutError("Unknown product in basket", 400);
            }
        }

        const productIds = Array.from(new Set([...wanted.values()].map((l) => l.productId)));
        const products = await this.productRepo.find({
            where: { id: In(productIds), isActive: true, isFulfillable: true },
        });
        const byId = new Map(products.map((p) => [p.id, p]));

        const items: ShopOrderLine[] = [];
        let subtotalCents = 0;
        for (const line of wanted.values()) {
            const p = byId.get(line.productId);
            if (!p) throw new CheckoutError("One of the items is no longer available", 409);
            if (!p.inStock) throw new CheckoutError(`"${p.name}" is out of stock`, 409);

            const variant = this.resolveVariant(p, line.variantId);

            const unitCents = cents(variant.retail);
            if (unitCents <= 0) throw new CheckoutError("One of the items is not priced", 409);
            const lineCents = unitCents * line.quantity;
            subtotalCents += lineCents;

            items.push({
                productId: p.id,
                zendropProductId: p.zendropProductId,
                variantId: variant.storeVariantId,
                variantTitle: variant.title,
                name: p.name,
                image: variant.image || p.image,
                unitPrice: unitCents / 100,
                quantity: line.quantity,
                lineTotal: lineCents / 100,
            });
        }

        // Shipping to anywhere but the baseline market is charged as the
        // difference, because the retail price already carries US shipping.
        // Quoted per product, since this catalogue ranges from under a dollar
        // to over twelve for the same destination.
        let shippingCents = 0;
        if (country !== BASELINE_COUNTRY) {
            const ordered = [...wanted.values()].map((l) => byId.get(l.productId)!).filter(Boolean);
            const quotes = await this.shipping.quoteMany(ordered, country);
            // Every blocked item is named at once. Reporting them one at a
            // time would make a shopper discover a four item problem over
            // four attempts, and roughly one product in fourteen here comes
            // from a US supplier that ships nowhere else.
            const blocked: string[] = [];
            for (const line of wanted.values()) {
                const p = byId.get(line.productId)!;
                const quote = quotes.get(p.id);
                if (!quote) {
                    blocked.push(p.name);
                    continue;
                }
                shippingCents += cents(this.shipping.surchargePerUnit(p, quote)) * line.quantity;
            }
            if (blocked.length) {
                const names = blocked.map((n) => `"${n.slice(0, 60)}"`).join(", ");
                throw new CheckoutError(
                    blocked.length === 1
                        ? `${names} cannot be shipped to that country. Remove it or choose another destination.`
                        : `${blocked.length} items cannot be shipped to that country: ${names}. Remove them or choose another destination.`,
                    409,
                );
            }
        }

        return {
            items,
            subtotal: subtotalCents / 100,
            shippingTotal: shippingCents / 100,
            total: (subtotalCents + shippingCents) / 100,
            country,
        };
    }

    /**
     * Destination for this basket, rejected unless we actually sell there.
     *
     * Validated here rather than left to Stripe: Stripe only restricts the
     * address dropdown because we hand it a list, so an unchecked country
     * would be priced on a US shipping quote and shipped at a loss.
     */
    async resolveCountry(raw: unknown): Promise<string> {
        const country = ShippingQuoteService.normaliseCountry(raw) || BASELINE_COUNTRY;
        const allowed = await this.allowedCountries();
        if (!allowed.includes(country)) {
            throw new CheckoutError("We do not deliver to that country yet", 400);
        }
        return country;
    }

    /**
     * Pick the variant this line is for.
     *
     * A product with one variant needs no choice, so an absent variantId is
     * fine there and only there. Anything with options is refused outright
     * rather than defaulted: shipping the wrong size is a refund, a return
     * and a lost customer, which is far worse than an error message.
     */
    private resolveVariant(p: ShopProduct, variantId: string | null): ShopProductVariant {
        const variants = (p.variants || []).filter((v) => v && v.storeVariantId);
        if (!variants.length) {
            throw new CheckoutError(`"${p.name}" is not available to order right now`, 409);
        }
        if (variantId) {
            const match = variants.find((v) => String(v.storeVariantId) === variantId);
            if (!match) throw new CheckoutError(`That option of "${p.name}" is no longer available`, 409);
            if (match.inStock === false) throw new CheckoutError(`"${p.name}" (${match.title}) is out of stock`, 409);
            return match;
        }
        if (variants.length > 1) {
            throw new CheckoutError(`Choose an option for "${p.name}" before checking out`, 400);
        }
        if (variants[0].inStock === false) throw new CheckoutError(`"${p.name}" is out of stock`, 409);
        return variants[0];
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
        country?: string;
    }): Promise<{ orderId: string; orderNumber: string; total: number; checkoutUrl: string }> {
        const country = await this.resolveCountry(params.country);
        const { items, subtotal, shippingTotal, total } = await this.quote(params.lines, country);

        const order = this.orderRepo.create({
            orderNumber: orderNumber(),
            email: (params.email || "").trim().toLowerCase().slice(0, 200),
            items,
            subtotal,
            shippingTotal,
            total,
            shippingCountry: country,
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
                line_items: [
                    ...items.map((i) => ({
                        quantity: i.quantity,
                        price_data: {
                            currency: "usd" as const,
                            unit_amount: cents(i.unitPrice),
                            product_data: {
                                name: i.name.slice(0, 250),
                                ...(i.image ? { images: [i.image] } : {}),
                            },
                        },
                    })),
                    // Shown as its own line so the shopper can see exactly what
                    // the destination adds, rather than finding it folded into
                    // the item prices.
                    ...(shippingTotal > 0
                        ? [{
                            quantity: 1,
                            price_data: {
                                currency: "usd" as const,
                                unit_amount: cents(shippingTotal),
                                product_data: { name: `International shipping to ${country}` },
                            },
                        }]
                        : []),
                ],
                // Only the country this basket was priced for. Offering the
                // whole list here would let a shopper pick a destination we
                // did not quote and ship it at a loss.
                shipping_address_collection: { allowed_countries: [country] as any },
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
