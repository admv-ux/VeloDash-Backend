import { Request, Response } from "express";
import { ShopCatalogService } from "../services/shop/shop-catalog-service";
import { MerchantApplicationService, MerchantApplicationError } from "../services/shop/merchant-application-service";
import { ShopCheckoutService, CheckoutError } from "../services/shop/shop-checkout-service";
import logger from "../utils/logger";

const log = logger.child({ controller: "Shop" });

/** Public storefront reads. No auth: browsing must not require an account. */
export class ShopController {
    private catalog = new ShopCatalogService();
    private applications = new MerchantApplicationService();
    private checkout = new ShopCheckoutService();

    /**
     * Where Stripe sends the shopper back to. Built here, never taken from the
     * request: a success_url the caller supplies is an open redirect, and it
     * is one Stripe itself would send the victim to.
     */
    private get shopBaseUrl(): string {
        return (process.env.SHOP_BASE_URL || "https://shopvelodash.com").replace(/\/+$/, "");
    }

    /**
     * POST /shop/checkout
     * Public and guest friendly. Takes ids and quantities only; every price
     * is recomputed from our own records.
     */
    startCheckout = async (req: Request, res: Response) => {
        try {
            const result = await this.checkout.createCheckout({
                lines: req.body?.items,
                email: req.body?.email,
                country: req.body?.country,
                successUrl: `${this.shopBaseUrl}/order/{ORDER_ID}`,
                cancelUrl: `${this.shopBaseUrl}/cart?cancelled=1`,
            });
            res.status(201).json(result);
        } catch (e) {
            if (e instanceof CheckoutError) {
                res.status(e.statusCode).json({ message: e.message });
                return;
            }
            log.error("startCheckout failed", { error: (e as Error).message });
            res.status(500).json({ message: "Could not start checkout" });
        }
    };

    /**
     * POST /shop/quote - price a basket for a destination without creating an
     * order.
     *
     * The cart needs to show what a country adds before anyone commits to
     * paying, and shipping is quoted per product per country, so it cannot be
     * worked out in the browser.
     */
    quoteBasket = async (req: Request, res: Response) => {
        try {
            const country = await this.checkout.resolveCountry(req.body?.country);
            const quote = await this.checkout.quote(req.body?.items, country);
            res.json({
                country: quote.country,
                subtotal: quote.subtotal,
                shippingTotal: quote.shippingTotal,
                total: quote.total,
                items: quote.items.map((i) => ({
                    productId: i.productId,
                    variantId: i.variantId,
                    name: i.name,
                    quantity: i.quantity,
                    lineTotal: i.lineTotal,
                })),
            });
        } catch (e) {
            if (e instanceof CheckoutError) {
                res.status(e.statusCode).json({ message: e.message });
                return;
            }
            log.error("quoteBasket failed", { error: (e as Error).message });
            res.status(500).json({ message: "Could not price that basket" });
        }
    };

    /** GET /shop/orders/:id - the uuid is the capability token. */
    getOrder = async (req: Request, res: Response) => {
        try {
            const order = await this.checkout.getOrder(req.params.id);
            if (!order) {
                res.status(404).json({ message: "Order not found" });
                return;
            }
            res.json({
                order: {
                    id: order.id,
                    orderNumber: order.orderNumber,
                    email: order.email,
                    items: order.items,
                    subtotal: Number(order.subtotal),
                    total: Number(order.total),
                    currency: order.currency,
                    status: order.status,
                    fulfillmentStatus: order.fulfillmentStatus,
                    paidAt: order.paidAt,
                    shippingAddress: order.shippingAddress,
                    createdAt: order.createdAt,
                },
            });
        } catch (e) {
            log.error("getOrder failed", { error: (e as Error).message });
            res.status(500).json({ message: "Could not load order" });
        }
    };

    /** GET /shop/shipping-countries - so the storefront can say where it ships. */
    getShippingCountries = async (_req: Request, res: Response) => {
        try {
            const [countries, origins] = await Promise.all([
                this.checkout.allowedCountries(),
                this.catalog.origins(),
            ]);
            // Origins ship with the destinations because the shipping page has
            // to answer "from where" and "how long" in the same breath as
            // "where to", and a second request just to say "mostly China" is
            // a request the page would sometimes render without.
            res.json({ countries, origins });
        } catch (e) {
            log.error("getShippingCountries failed", { error: (e as Error).message });
            res.status(500).json({ message: "Could not load shipping countries" });
        }
    };

    listProducts = async (req: Request, res: Response) => {
        try {
            const num = (v: any) => (v === undefined || v === "" ? undefined : Number(v));
            const result = await this.catalog.list({
                search: (req.query.search as string) || undefined,
                categoryId: num(req.query.categoryId),
                minPrice: num(req.query.minPrice),
                maxPrice: num(req.query.maxPrice),
                sort: req.query.sort as any,
                page: num(req.query.page),
                limit: num(req.query.limit),
            });
            res.json(result);
        } catch (e) {
            log.error("listProducts failed", { error: (e as Error).message });
            res.status(500).json({ message: "Could not load products" });
        }
    };

    getProduct = async (req: Request, res: Response) => {
        try {
            const product = await this.catalog.getById(req.params.id);
            if (!product) {
                res.status(404).json({ message: "Product not found" });
                return;
            }
            res.json({ product });
        } catch (e) {
            log.error("getProduct failed", { error: (e as Error).message });
            res.status(500).json({ message: "Could not load product" });
        }
    };

    getCategories = async (_req: Request, res: Response) => {
        try {
            res.json({ categories: await this.catalog.categories() });
        } catch (e) {
            log.error("getCategories failed", { error: (e as Error).message });
            res.status(500).json({ message: "Could not load categories" });
        }
    };

    getPriceRange = async (_req: Request, res: Response) => {
        try {
            res.json(await this.catalog.priceRange());
        } catch (e) {
            log.error("getPriceRange failed", { error: (e as Error).message });
            res.status(500).json({ message: "Could not load price range" });
        }
    };

    /** Public "Sell with VeloDash" form. No account needed to apply. */
    submitMerchantApplication = async (req: Request, res: Response) => {
        try {
            const application = await this.applications.submit(req.body || {});
            res.status(201).json({ id: application.id, status: application.status });
        } catch (e) {
            if (e instanceof MerchantApplicationError) {
                res.status(400).json({ message: e.message });
                return;
            }
            log.error("submitMerchantApplication failed", { error: (e as Error).message });
            res.status(500).json({ message: "Could not submit your application" });
        }
    };
}
