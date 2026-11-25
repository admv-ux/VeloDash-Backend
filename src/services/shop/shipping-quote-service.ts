import { AppDataSource } from "../../db/data-source";
import { ShopProduct } from "../../models/shop-product";
import { callZendropTool, zendropConfigured } from "./zendrop-client";
import logger from "../../utils/logger";

const log = logger.child({ service: "ShippingQuote" });

/**
 * What it costs to get one product to one country.
 *
 * Retail prices are built on the US shipping quote, so a shopper elsewhere
 * has to cover the difference or we sell below cost. Zendrop quotes per
 * product per country, which means the only honest way to ship worldwide is
 * to ask them per destination rather than apply one international surcharge
 * to a catalogue whose shipping ranges from under a dollar to over ten.
 *
 * Quotes are cached on the product because Zendrop takes about half a second
 * per call and rate limits sustained traffic, and a basket of five items to a
 * new country would otherwise put five serial upstream calls inside checkout.
 */

/** The market every retail price was built on. */
export const BASELINE_COUNTRY = "US";

/**
 * A cached quote older than this is refreshed. Shipping rates move slowly and
 * a stale quote only ever costs us the difference on one order, so this is
 * deliberately long: the alternative is hammering a rate limited upstream.
 */
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Cache misses are fetched a few at a time. Serial would make a five line
 * basket feel broken; the full six that tripped Zendrop's limit during the
 * catalogue sync is too many for a burst that happens inside a request.
 */
const LOOKUP_CONCURRENCY = 3;

export interface CountryQuote {
    cost: number;
    eta: string | null;
}

export class ShippingUnavailableError extends Error {
    constructor(readonly productName: string, readonly country: string) {
        super(`We cannot ship "${productName}" to ${country} yet`);
        this.name = "ShippingUnavailableError";
    }
}

export class ShippingQuoteService {
    private productRepo = AppDataSource.getRepository(ShopProduct);

    /** Normalised ISO-3166-1 alpha-2, or null when it is not one. */
    static normaliseCountry(raw: unknown): string | null {
        const c = String(raw || "").trim().toUpperCase();
        return /^[A-Z]{2}$/.test(c) ? c : null;
    }

    private fresh(entry: { at: string } | null | undefined): boolean {
        if (entry === null) return false;
        if (!entry?.at) return false;
        return Date.now() - new Date(entry.at).getTime() < CACHE_TTL_MS;
    }

    /** Ask Zendrop for the cheapest option, or null when it serves nowhere there. */
    private async fetchQuote(zendropProductId: number, country: string): Promise<CountryQuote | null> {
        const res = await callZendropTool<{
            shipping_options: { type: string; price: number; estimated_delivery: string | null }[];
        }>("get_catalog_shipping_estimate", { product_id: zendropProductId, country_code: country });
        const options = res?.shipping_options || [];
        if (!options.length) return null;
        const best = options.reduce((a, b) => (Number(b.price) < Number(a.price) ? b : a));
        return { cost: Number(best.price) || 0, eta: best.estimated_delivery ?? null };
    }

    /**
     * Quotes for several products at once, keyed by product id.
     *
     * A value of null means Zendrop will not ship that product there. That is
     * a real answer and is cached, so the same dead end is not re-asked on
     * every basket.
     */
    async quoteMany(products: ShopProduct[], country: string): Promise<Map<string, CountryQuote | null>> {
        const out = new Map<string, CountryQuote | null>();

        // The baseline needs no upstream call: it is already on the row.
        if (country === BASELINE_COUNTRY) {
            for (const p of products) {
                out.set(p.id, { cost: Number(p.shippingCost) || 0, eta: p.estimatedDelivery });
            }
            return out;
        }

        const misses: ShopProduct[] = [];
        for (const p of products) {
            const cached = (p.shippingByCountry || {})[country];
            if (cached === null) {
                out.set(p.id, null);
            } else if (this.fresh(cached)) {
                out.set(p.id, { cost: Number(cached!.cost), eta: cached!.eta });
            } else {
                misses.push(p);
            }
        }

        if (!misses.length) return out;
        if (!zendropConfigured()) {
            // Without upstream we cannot price a destination we have never
            // seen. Refusing is right: the alternative is inventing a number.
            for (const p of misses) out.set(p.id, null);
            return out;
        }

        let i = 0;
        const workers = Array.from({ length: Math.min(LOOKUP_CONCURRENCY, misses.length) }, async () => {
            while (i < misses.length) {
                const p = misses[i++];
                try {
                    const quote = await this.fetchQuote(p.zendropProductId, country);
                    out.set(p.id, quote);
                    await this.remember(p, country, quote);
                } catch (e) {
                    // An upstream failure is NOT a "cannot ship there": leave
                    // it unknown so the next attempt can ask again, and let
                    // the caller refuse this one order rather than poisoning
                    // the cache with a wrong permanent answer.
                    log.warn("Shipping quote failed", {
                        productId: p.id, country, error: (e as Error).message,
                    });
                    out.set(p.id, null);
                }
            }
        });
        await Promise.all(workers);
        return out;
    }

    /** Write one quote into the product's cache without disturbing the others. */
    private async remember(product: ShopProduct, country: string, quote: CountryQuote | null): Promise<void> {
        const next = { ...(product.shippingByCountry || {}) };
        next[country] = quote ? { cost: quote.cost, eta: quote.eta, at: new Date().toISOString() } : null;
        product.shippingByCountry = next;
        await this.productRepo.update({ id: product.id }, { shippingByCountry: next });
    }

    /**
     * What to add to a line so the order still covers its landed cost.
     *
     * The retail price already carries US shipping, so only the difference is
     * charged. A destination that is CHEAPER than the US costs the shopper
     * nothing extra and quietly widens our margin, which is the right way
     * round: never a surcharge that is not a real cost.
     *
     * The processor takes its percentage of the surcharge as well, so the
     * difference is grossed up by that much. Charging the bare difference
     * recovers the courier but not the fee on it, and the shortfall is the
     * same kind of quiet leak the shelf price had.
     */
    surchargePerUnit(product: ShopProduct, quote: CountryQuote, feeRatePct = 0): number {
        const baseline = Number(product.shippingCost) || 0;
        const delta = quote.cost - baseline;
        if (!(delta > 0)) return 0;
        const rate = Math.min(0.5, Math.max(0, Number(feeRatePct) || 0) / 100);
        return Math.round((delta / (1 - rate)) * 100) / 100;
    }
}
