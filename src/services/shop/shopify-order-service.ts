import { ShopOrder } from "../../models/shop-order";
import logger from "../../utils/logger";

const log = logger.child({ service: "ShopifyOrder" });

/**
 * Puts a paid order into the Shopify store so Zendrop can see it.
 *
 * This step exists because of a hard limit in Zendrop's API: it has no
 * create_order tool. `tools/list` returns fulfil, cancel, track, cost and
 * issue tools, but nothing that injects an order. Zendrop only ever learns
 * about an order by reading it from the connected store. So the money path
 * has to be:
 *
 *     Stripe paid -> order created in Shopify -> Zendrop ingests it -> fulfil
 *
 * The Shopify order is a fulfilment instruction, not a sale. The sale already
 * happened on shopvelodash.com through Stripe, so receipts are suppressed:
 * a second confirmation from a myshopify.com address the customer has never
 * heard of would read as a phishing attempt.
 */

export const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || "hgrv28-fx.myshopify.com";
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-07";
const TIMEOUT_MS = 20_000;

export class ShopifyError extends Error {
    constructor(message: string, readonly status?: number) {
        super(message);
        this.name = "ShopifyError";
    }
}

export class ShopifyNotConfiguredError extends ShopifyError {
    constructor() {
        super("Shopify Admin API is not configured");
        this.name = "ShopifyNotConfiguredError";
    }
}

export function shopifyConfigured(): boolean {
    return Boolean(process.env.SHOPIFY_ADMIN_TOKEN);
}

export interface ShopifyOrderRef {
    id: string;
    name: string;
}

/**
 * Shopify wants a flat address. Stripe's shipping_details nests the postal
 * fields under `address` and keeps the recipient's name beside it, so the two
 * shapes are mapped here rather than at the call site.
 */
export function toShopifyAddress(shipping: Record<string, any> | null): Record<string, any> | null {
    if (!shipping) return null;
    const a = shipping.address || shipping;
    const full = String(shipping.name || "").trim();
    const cut = full.lastIndexOf(" ");
    return {
        first_name: cut > 0 ? full.slice(0, cut) : full || "Customer",
        last_name: cut > 0 ? full.slice(cut + 1) : "",
        address1: a.line1 || a.address1 || "",
        address2: a.line2 || a.address2 || "",
        city: a.city || "",
        province: a.state || a.province || "",
        zip: a.postal_code || a.zip || "",
        country_code: String(a.country || "").toUpperCase().slice(0, 2),
        phone: shipping.phone || a.phone || null,
    };
}

export class ShopifyOrderService {
    private async request<T>(path: string, body: any): Promise<T> {
        const token = process.env.SHOPIFY_ADMIN_TOKEN;
        if (!token) throw new ShopifyNotConfiguredError();

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        let res: Response;
        try {
            res = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}${path}`, {
                method: "POST",
                signal: controller.signal,
                headers: {
                    "X-Shopify-Access-Token": token,
                    "Content-Type": "application/json",
                    Accept: "application/json",
                },
                body: JSON.stringify(body),
            });
        } catch (e) {
            const reason = (e as Error).name === "AbortError" ? `timed out after ${TIMEOUT_MS}ms` : (e as Error).message;
            throw new ShopifyError(`Shopify request ${reason}`);
        } finally {
            clearTimeout(timer);
        }

        const raw = await res.text();
        if (!res.ok) {
            // Shopify puts the useful part in `errors`, which is sometimes a
            // string and sometimes a field map, so it is logged verbatim.
            log.warn("Shopify rejected the order", { status: res.status, body: raw.slice(0, 500) });
            throw new ShopifyError(`Shopify responded ${res.status}: ${raw.slice(0, 300)}`, res.status);
        }
        try {
            return JSON.parse(raw) as T;
        } catch {
            throw new ShopifyError("Shopify returned a non-JSON response");
        }
    }

    /**
     * Create the store order for an already paid shop order.
     *
     * `inventory_behaviour: bypass` is deliberate: these are dropshipped
     * goods with no stock levels of our own, and the default would refuse the
     * order for an untracked variant.
     */
    async createOrder(order: ShopOrder): Promise<ShopifyOrderRef> {
        const lines = order.items || [];
        if (!lines.length) throw new ShopifyError("Order has no items");

        const missing = lines.filter((l) => !l.variantId || !/^\d+$/.test(String(l.variantId)));
        if (missing.length) {
            // Without a store variant id Zendrop would have nothing to ship,
            // so this refuses rather than sending a line it cannot fulfil.
            throw new ShopifyError(
                `No store variant for: ${missing.map((l) => l.name).join(", ")}`,
            );
        }

        const address = toShopifyAddress(order.shippingAddress);
        if (!address || !address.address1 || !address.country_code) {
            throw new ShopifyError("Order has no usable delivery address");
        }

        const shipping = Number(order.shippingTotal) || 0;
        const payload = {
            order: {
                email: order.email || undefined,
                currency: order.currency || "USD",
                financial_status: "paid",
                inventory_behaviour: "bypass",
                // The customer was already emailed by us and by Stripe. A
                // myshopify.com receipt here would be a second, unbranded one.
                send_receipt: false,
                send_fulfillment_receipt: false,
                line_items: lines.map((l) => ({
                    variant_id: Number(l.variantId),
                    quantity: l.quantity,
                    price: Number(l.unitPrice).toFixed(2),
                })),
                shipping_address: address,
                shipping_lines: shipping > 0
                    ? [{ title: `Delivery to ${order.shippingCountry}`, price: shipping.toFixed(2), code: "VELO" }]
                    : [],
                // Marks the order paid without inventing a payment gateway.
                transactions: [{
                    kind: "sale",
                    status: "success",
                    amount: Number(order.total).toFixed(2),
                    gateway: "manual",
                }],
                note: `shopvelodash.com ${order.orderNumber} (Stripe ${order.stripePaymentIntentId || "n/a"})`,
                tags: "velo-shop",
            },
        };

        const out = await this.request<{ order: { id: number; name: string } }>("/orders.json", payload);
        if (!out?.order?.id) throw new ShopifyError("Shopify did not return an order id");

        log.info("Pushed order to Shopify", {
            orderNumber: order.orderNumber, shopifyOrderId: out.order.id, name: out.order.name,
        });
        return { id: String(out.order.id), name: out.order.name };
    }
}
