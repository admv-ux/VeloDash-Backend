import { AppDataSource } from "../../db/data-source";
import { ShopProduct, ShopProductVariant } from "../../models/shop-product";
import { ShopCategory } from "../../models/shop-category";
import { callZendropTool, zendropConfigured } from "./zendrop-client";
import { retailPriceFor } from "../../config/shop-pricing";
import logger from "../../utils/logger";

const log = logger.child({ service: "StoreSync" });

/**
 * Syncs the catalogue we can actually SELL: the products that exist in the
 * connected Shopify store.
 *
 * Why this exists at all. Zendrop has no create_order tool; it only fulfils
 * orders that arrive from a connected store, and `fulfill_order` matches line
 * items back to products in that store. A row from Zendrop's 1.3M product
 * catalogue that was never pushed to the store therefore cannot be shipped,
 * however nicely it lists. Before this service the shop was listing 148
 * catalogue rows of which exactly zero existed in the store, so every one of
 * them was unsellable.
 *
 * So the store, not the catalogue, is the source of truth for what we offer.
 * The catalogue is consulted only for the one thing the store cannot tell us:
 * what the item costs us.
 */

/** The store Zendrop fulfils from. */
export const STORE_ID = Number(process.env.ZENDROP_STORE_ID) || 3941837;

/** US is the reference market for the markup, per the pricing rule. */
const PRICING_COUNTRY = "US";

/** get_my_products caps a page at 60 whatever limit you ask for. */
const IMPORT_PAGE_SIZE = 60;

/**
 * Zendrop enforces a sustained quota, not a burst limit. Six concurrent calls
 * got every subsequent request served a Cloudflare 429 challenge for several
 * minutes, which no short backoff recovers from. So this runs strictly one
 * call at a time with a gap between them, and a slow sync is the price.
 */
const CALL_GAP_MS = Number(process.env.ZENDROP_CALL_GAP_MS) || 1200;

/**
 * A dropshipped consumer good priced above this is a bad record, not a
 * bargain. Zendrop pushed a knit sweater to the store at $52,257.76, and a
 * price like that is one accidental purchase away from a real loss, so the
 * variant is dropped and the product flagged rather than sold.
 */
const MAX_SANE_RETAIL = 2000;

/**
 * Advisory lock key for a store sync.
 *
 * The API runs two replicas and both schedule the same pass, so without this
 * the store gets synced twice at once: the same rows written twice for no
 * benefit, and, far worse, double the request rate at an upstream that rate
 * limits sustained traffic and then refuses everything for minutes. The lock
 * is advisory and session scoped, so a pod dying mid pass releases it when
 * its connection drops rather than wedging the job forever.
 */
const SYNC_LOCK_KEY = 848201;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ImportListEntry {
    import_list_id: number;
    product_id: number;
    product_name: string;
    product_image_url: string | null;
    import_status: string;
    store_product_id: string | null;
}

interface StoreVariant {
    store_variant_id: string;
    variant_title: string;
    variant_sku: string | null;
    variant_price: number;
    variant_image_url: string | null;
}

interface CatalogVariant {
    variant_id: number;
    sku: string | null;
    size?: string | null;
    color?: string | null;
    price: string | number;
    available?: boolean | null;
    inventory_level?: string | null;
}

export interface StoreSyncResult {
    listed: number;
    synced: number;
    skipped: number;
    delisted: number;
    errors: string[];
}

/** "18 inch / Black", or the product name when the variant has no options. */
function variantTitle(cv: CatalogVariant | undefined, sv: StoreVariant, fallback: string): string {
    const parts = [cv?.size, cv?.color].map((x) => (x || "").trim()).filter(Boolean);
    if (parts.length) return parts.join(" / ");
    const t = (sv.variant_title || "").trim();
    // Zendrop repeats the whole product name as the variant title on single
    // variant products, which reads as noise next to the product heading.
    return t && t !== fallback ? t : "Default";
}

export class StoreSyncService {
    private productRepo = AppDataSource.getRepository(ShopProduct);
    private categoryRepo = AppDataSource.getRepository(ShopCategory);

    get configured(): boolean {
        return zendropConfigured();
    }

    /** Every import-list entry for the store, across all pages. */
    private async importList(): Promise<ImportListEntry[]> {
        const out: ImportListEntry[] = [];
        for (let page = 1; page <= 50; page++) {
            const res = await callZendropTool<{ total: number; items: ImportListEntry[] }>(
                "get_my_products",
                { store_id: STORE_ID, limit: IMPORT_PAGE_SIZE, page },
            );
            const items = res?.items || [];
            out.push(...items);
            await sleep(CALL_GAP_MS);
            if (!items.length || out.length >= Number(res?.total || 0)) break;
        }
        return out;
    }

    /**
     * Build the variant list by joining the store's variants to the
     * catalogue's.
     *
     * SKU is the join key because it is the one field both sides carry from
     * the same supplier record. When a SKU is missing or ambiguous the
     * variants are paired by position, which is the order both APIs return
     * them in; a variant we cannot price at all is dropped rather than
     * guessed, since shipping is most of the landed cost on cheap items.
     */
    private buildVariants(
        storeVariants: StoreVariant[],
        catalogVariants: CatalogVariant[],
        fallbackWholesale: number,
        shippingCost: number,
        productName: string,
        productImage: string | null,
    ): { variants: ShopProductVariant[]; dropped: number } {
        const bySku = new Map<string, CatalogVariant>();
        for (const cv of catalogVariants) {
            const sku = (cv.sku || "").trim();
            // A duplicated SKU is not a usable key, so neither copy is indexed.
            if (!sku) continue;
            if (bySku.has(sku)) bySku.set(sku, undefined as unknown as CatalogVariant);
            else bySku.set(sku, cv);
        }

        const variants: ShopProductVariant[] = [];
        let dropped = 0;

        storeVariants.forEach((sv, i) => {
            const sku = (sv.variant_sku || "").trim();
            const match = (sku && bySku.get(sku)) || catalogVariants[i];
            const wholesale = Number(match?.price ?? fallbackWholesale) || 0;
            if (!sv.store_variant_id || wholesale <= 0) {
                dropped++;
                return;
            }

            const price = retailPriceFor(wholesale, shippingCost);
            if (price.retail <= price.cost || price.retail > MAX_SANE_RETAIL) {
                dropped++;
                return;
            }

            variants.push({
                sku: sku || null,
                title: variantTitle(match, sv, productName),
                storeVariantId: String(sv.store_variant_id),
                zendropVariantId: match?.variant_id ?? null,
                wholesale: price.wholesale,
                landedCost: price.cost,
                retail: price.retail,
                image: sv.variant_image_url || productImage,
                // Zendrop reports stock per product far more reliably than per
                // variant, so an explicit false is honoured and a null is not
                // read as out of stock.
                inStock: match?.available !== false,
            });
        });

        return { variants, dropped };
    }

    /**
     * Record the product's category and mark it carried.
     *
     * The storefront only offers categories flagged `isCarried`, and the
     * category tree is mirrored by a different job that may not have run. So
     * the row is created here if it is missing: otherwise a product synced
     * from the store lands with a category nothing will ever show it under,
     * and the whole category filter comes back empty.
     */
    private async applyCategory(row: ShopProduct, categories?: { id: number; name: string }[]): Promise<void> {
        const first = (categories || [])[0];
        if (!first?.id) return;

        row.categoryId = first.id;
        row.categoryName = first.name || null;

        let category = await this.categoryRepo.findOne({ where: { zendropCategoryId: first.id } });
        if (!category) {
            category = this.categoryRepo.create({
                zendropCategoryId: first.id,
                name: first.name || `Category ${first.id}`,
                parentId: null,
                productCount: 0,
            });
        }
        // A freshly created row has no isCarried yet, so this also persists it.
        if (!category.isCarried) {
            category.isCarried = true;
            await this.categoryRepo.save(category);
        }
    }

    /** Cheapest US shipping option, or null when Zendrop will not ship it there. */
    private async shippingFor(productId: number): Promise<{ cost: number; eta: string | null } | null> {
        const res = await callZendropTool<{
            shipping_options: { type: string; price: number; estimated_delivery: string | null }[];
        }>("get_catalog_shipping_estimate", { product_id: productId, country_code: PRICING_COUNTRY });
        await sleep(CALL_GAP_MS);
        const options = res?.shipping_options || [];
        if (!options.length) return null;
        const best = options.reduce((a, b) => (Number(b.price) < Number(a.price) ? b : a));
        return { cost: Number(best.price) || 0, eta: best.estimated_delivery ?? null };
    }

    /**
     * Sync one import-list entry into a sellable product row.
     *
     * Returns false when the product cannot be sold, in which case the row is
     * left unfulfillable rather than listed at a guessed price.
     */
    async syncOne(entry: ImportListEntry): Promise<boolean> {
        const mine = await callZendropTool<{
            store_product_id: string | null;
            store_sync_status: string;
            zendrop_linked: boolean;
            variants: StoreVariant[];
        }>("get_my_product", { store_id: STORE_ID, import_list_id: entry.import_list_id });
        await sleep(CALL_GAP_MS);

        const cat = await callZendropTool<{
            id: number;
            name: string;
            description?: string | null;
            image?: string | null;
            images?: { id: number; url: string }[];
            price: string | number;
            availability?: { in_stock?: boolean };
            categories?: { id: number; name: string }[];
            variants?: CatalogVariant[];
            supplier?: { name?: string; country?: string };
        }>("get_catalog_product", { product_id: entry.product_id });
        await sleep(CALL_GAP_MS);

        const ship = await this.shippingFor(entry.product_id);

        const existing = await this.productRepo.findOne({ where: { zendropProductId: entry.product_id } });
        // wholesalePrice is NOT NULL with no database default, so a new row has
        // to carry a number before the unshippable path below tries to save it.
        // Without this the insert threw and the row was never recorded at all,
        // which is how 7 products Zendrop will not ship to the US vanished from
        // the admin instead of showing up there as unsellable.
        const row = existing || this.productRepo.create({
            zendropProductId: entry.product_id,
            wholesalePrice: 0,
            shippingCost: 0,
            landedCost: 0,
            multiplier: 0,
            retailPrice: 0,
        });

        row.name = cat?.name || entry.product_name;
        row.description = cat?.description ?? null;
        row.image = cat?.image ?? entry.product_image_url ?? null;
        row.images = (cat?.images || []).map((i) => i.url).filter(Boolean);
        row.supplierName = cat?.supplier?.name ?? null;
        row.shipsFrom = cat?.supplier?.country ?? null;
        row.importListId = entry.import_list_id;
        row.shopifyProductId = mine?.store_product_id ? String(mine.store_product_id) : null;
        row.inStock = cat?.availability?.in_stock !== false;
        row.lastSyncedAt = new Date();
        await this.applyCategory(row, cat?.categories);

        // No US shipping quote means no landed cost, and a product priced on a
        // guessed shipping cost is how you sell below cost. Keep the row for
        // the admin to see, but never offer it.
        if (!ship) {
            row.isFulfillable = false;
            row.estimatedDelivery = null;
            await this.productRepo.save(row);
            return false;
        }

        row.estimatedDelivery = ship.eta;
        row.shippingCost = ship.cost;

        const { variants } = this.buildVariants(
            mine?.variants || [],
            cat?.variants || [],
            Number(cat?.price) || 0,
            ship.cost,
            row.name,
            row.image,
        );
        row.variants = variants;

        if (!variants.length || !row.shopifyProductId || mine?.store_sync_status !== "synced") {
            row.isFulfillable = false;
            await this.productRepo.save(row);
            return false;
        }

        // The listed price is the cheapest variant, so the grid never promises
        // less than the product detail page can honour.
        const cheapest = variants.reduce((a, b) => (b.retail < a.retail ? b : a));
        row.wholesalePrice = cheapest.wholesale;
        row.landedCost = cheapest.landedCost;
        row.retailPrice = cheapest.retail;
        row.multiplier = Math.round((cheapest.retail / Math.max(cheapest.landedCost, 0.01)) * 100) / 100;
        row.isFulfillable = true;
        if (existing === null) row.isActive = true;

        await this.productRepo.save(row);
        return true;
    }

    /**
     * Full pass over the store.
     *
     * Anything previously sellable that has left the store is delisted in the
     * same pass, because a product pulled from the store upstream is a product
     * we silently stopped being able to ship.
     */
    async syncStore(limit?: number): Promise<StoreSyncResult> {
        // A dedicated connection, not AppDataSource.query. An advisory lock
        // belongs to the session that took it, and the pool hands out a
        // different connection per query: the unlock would run on a session
        // that never held the lock, silently fail, and leave the lock held
        // until that pooled connection happened to close. Every later pass
        // would then skip forever.
        const runner = AppDataSource.createQueryRunner();
        await runner.connect();
        try {
            const [lock] = await runner.query("SELECT pg_try_advisory_lock($1) AS ok", [SYNC_LOCK_KEY]);
            if (!lock?.ok) {
                log.info("Store sync already running elsewhere, skipping this pass");
                return { listed: 0, synced: 0, skipped: 0, delisted: 0, errors: ["A store sync is already running"] };
            }
            try {
                return await this.runSync(limit);
            } finally {
                await runner.query("SELECT pg_advisory_unlock($1)", [SYNC_LOCK_KEY]);
            }
        } finally {
            // Releasing the runner also ends the session, so even a crash
            // between the two queries cannot strand the lock.
            await runner.release();
        }
    }

    private async runSync(limit?: number): Promise<StoreSyncResult> {
        const entries = (await this.importList()).filter((e) => e.import_status === "in_store");
        const slice = limit && limit > 0 ? entries.slice(0, limit) : entries;

        const result: StoreSyncResult = {
            listed: entries.length,
            synced: 0,
            skipped: 0,
            delisted: 0,
            errors: [],
        };

        for (const entry of slice) {
            try {
                if (await this.syncOne(entry)) result.synced++;
                else result.skipped++;
            } catch (e) {
                result.skipped++;
                const msg = `${entry.product_id}: ${(e as Error).message}`;
                // Only the first few are kept; 125 copies of the same 429 tells
                // the reader nothing the first one did not.
                if (result.errors.length < 5) result.errors.push(msg.slice(0, 200));
                log.warn("Store product sync failed", { productId: entry.product_id, error: (e as Error).message });
            }
        }

        // Only a full pass may delist, since a partial pass has not seen the
        // products it did not reach.
        if (!limit) {
            const keep = entries.map((e) => e.product_id);
            const stale = await this.productRepo
                .createQueryBuilder()
                .update(ShopProduct)
                .set({ isFulfillable: false })
                .where("isFulfillable = true")
                .andWhere(keep.length ? "zendropProductId NOT IN (:...keep)" : "1 = 1", { keep })
                .execute();
            result.delisted = stale.affected || 0;
        }

        log.info("Store sync finished", { ...result, errors: result.errors.length });
        return result;
    }
}
