import { AppDataSource } from "../../db/data-source";
import { ShopProduct } from "../../models/shop-product";
import { ShopCategory } from "../../models/shop-category";
import { callZendropTool, zendropConfigured } from "./zendrop-client";
import { retailPriceFor } from "../../config/shop-pricing";
import logger from "../../utils/logger";

const log = logger.child({ service: "CatalogSync" });

/**
 * Pulls the Zendrop catalogue into our own tables.
 *
 * Upstream answers in 5 to 11 seconds per page, so this is a background job and
 * never sits in a request. Shipping is quoted per product, so those calls run in
 * small parallel batches rather than one at a time.
 */

/** US is the reference market for the markup, per the pricing rule. */
const PRICING_COUNTRY = "US";

/** Shipping quotes are ~1s each; a dozen at a time keeps a page under ~3s. */
const SHIPPING_BATCH = 12;

interface ZendropProduct {
    id: number;
    name: string;
    description?: string | null;
    image?: string | null;
    images?: { id: number; url: string }[];
    price: string | number;
    availability?: { in_stock?: boolean };
    supplier?: { name?: string; country?: string };
}

export class CatalogSyncService {
    private productRepo = AppDataSource.getRepository(ShopProduct);
    private categoryRepo = AppDataSource.getRepository(ShopCategory);

    /** Mirror the category tree. Cheap, one upstream call. */
    async syncCategories(): Promise<number> {
        const res = await callZendropTool<{ categories: any[] }>("get_catalog_categories", {});
        const categories = res?.categories || [];
        for (const c of categories) {
            const existing = await this.categoryRepo.findOne({ where: { zendropCategoryId: c.id } });
            const row = existing || this.categoryRepo.create({ zendropCategoryId: c.id, isCarried: false });
            row.name = c.name;
            row.parentId = c.parent_id ?? null;
            row.productCount = Number(c.visible_product_count || 0);
            await this.categoryRepo.save(row);
        }
        log.info("Categories synced", { count: categories.length });
        return categories.length;
    }

    /** US shipping quote for one product, or null when Zendrop has none. */
    private async shippingFor(productId: number): Promise<{ cost: number; eta: string | null } | null> {
        try {
            const res = await callZendropTool<{ shipping_options: { type: string; price: number; estimated_delivery: string | null }[] }>(
                "get_catalog_shipping_estimate",
                { product_id: productId, country_code: PRICING_COUNTRY },
            );
            const options = res?.shipping_options || [];
            if (!options.length) return null;
            // Cheapest option is the one we would actually buy.
            const best = options.reduce((a, b) => (Number(b.price) < Number(a.price) ? b : a));
            return { cost: Number(best.price) || 0, eta: best.estimated_delivery ?? null };
        } catch (e) {
            log.warn("Shipping estimate failed", { productId, error: (e as Error).message });
            return null;
        }
    }

    /**
     * Sync one page of one category.
     *
     * A product with no shipping quote is skipped rather than priced on a guess:
     * shipping is most of the landed cost on cheap items, so guessing it is how
     * you end up selling below cost.
     */
    async syncCategoryPage(categoryId: number, page = 1, limit = 50): Promise<{ saved: number; skipped: number }> {
        const res = await callZendropTool<{ total: number; products: ZendropProduct[] }>(
            "get_catalog_products",
            { category_id: categoryId, page, limit },
        );
        const products = res?.products || [];
        const category = await this.categoryRepo.findOne({ where: { zendropCategoryId: categoryId } });

        let saved = 0;
        let skipped = 0;

        for (let i = 0; i < products.length; i += SHIPPING_BATCH) {
            const batch = products.slice(i, i + SHIPPING_BATCH);
            const shipping = await Promise.all(batch.map(p => this.shippingFor(p.id)));

            for (let j = 0; j < batch.length; j++) {
                const p = batch[j];
                const ship = shipping[j];
                if (!ship) { skipped++; continue; }

                const price = retailPriceFor(Number(p.price) || 0, ship.cost);
                if (price.retail <= price.cost) { skipped++; continue; }

                const existing = await this.productRepo.findOne({ where: { zendropProductId: p.id } });
                const row = existing || this.productRepo.create({ zendropProductId: p.id });

                row.name = p.name;
                row.description = p.description ?? null;
                row.image = p.image ?? null;
                row.images = (p.images || []).map(img => img.url).filter(Boolean);
                row.wholesalePrice = price.wholesale;
                row.shippingCost = price.shipping;
                row.landedCost = price.cost;
                row.multiplier = price.multiplier;
                row.retailPrice = price.retail;
                row.categoryId = categoryId;
                row.categoryName = category?.name ?? null;
                row.supplierName = p.supplier?.name ?? null;
                row.shipsFrom = p.supplier?.country ?? null;
                row.estimatedDelivery = ship.eta;
                row.inStock = p.availability?.in_stock !== false;
                row.lastSyncedAt = new Date();
                if (existing === null) row.isActive = true;

                await this.productRepo.save(row);
                saved++;
            }
        }

        if (category && saved > 0 && !category.isCarried) {
            category.isCarried = true;
            await this.categoryRepo.save(category);
        }

        log.info("Category page synced", { categoryId, page, saved, skipped });
        return { saved, skipped };
    }

    /** True when the integration can run at all. */
    get configured(): boolean {
        return zendropConfigured();
    }
}
