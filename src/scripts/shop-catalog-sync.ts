import logger from "../utils/logger";
import { AppDataSource } from "../db/data-source";
import { ShopCategory } from "../models/shop-category";
import { CatalogSyncService } from "../services/shop/catalog-sync-service";
import { zendropConfigured } from "../services/shop/zendrop-client";

const log = logger.child({ service: "ShopCatalogSync" });

/**
 * Fills the shop catalogue slowly.
 *
 * Zendrop enforces a sustained quota, not just a burst limit: syncing seven
 * categories back to back got every call 429'd for minutes afterwards, and no
 * amount of short backoff recovers from that. So this takes ONE category page
 * per tick, far apart, and lets the catalogue fill over hours instead of
 * hammering an upstream that will simply stop answering.
 *
 * Off unless SHOP_SYNC_ENABLED is "true", so it can never surprise anyone by
 * burning quota in the background.
 */

const TICK_MS = Number(process.env.SHOP_SYNC_INTERVAL_MS) || 15 * 60 * 1000;
const PAGE_SIZE = 50;

/** Only categories big enough to be worth a slot. */
const MIN_PRODUCTS = 500;

let running = false;

export function startShopCatalogSync(): void {
    if (process.env.SHOP_SYNC_ENABLED !== "true") {
        log.info("Shop catalogue sync is off (set SHOP_SYNC_ENABLED=true to enable)");
        return;
    }
    if (!zendropConfigured()) {
        log.warn("Shop catalogue sync wanted but Zendrop is not configured");
        return;
    }

    const service = new CatalogSyncService();

    const tick = async () => {
        if (running) return;
        running = true;
        try {
            const repo = AppDataSource.getRepository(ShopCategory);

            // Prefer a category we do not carry yet, largest first, so the shop
            // gains breadth before it gains depth.
            const next = await repo.createQueryBuilder("c")
                .where("c.isCarried = false")
                .andWhere("c.productCount >= :min", { min: MIN_PRODUCTS })
                .orderBy("c.productCount", "DESC")
                .getOne();

            if (!next) {
                log.info("Shop catalogue sync has nothing left to add");
                return;
            }

            const result = await service.syncCategoryPage(next.zendropCategoryId, 1, PAGE_SIZE);
            log.info("Shop catalogue sync tick", {
                category: next.name,
                saved: result.saved,
                skipped: result.skipped,
            });

            // A category that yielded nothing is marked carried anyway, so the
            // job moves on instead of retrying the same dud every tick forever.
            if (result.saved === 0) {
                next.isCarried = true;
                await repo.save(next);
                log.warn("Category produced nothing, skipping it from now on", { category: next.name });
            }
        } catch (e) {
            // A 429 here is expected occasionally; the next tick is far enough
            // away that it will usually have cleared.
            log.warn("Shop catalogue sync tick failed", { error: (e as Error).message });
        } finally {
            running = false;
        }
    };

    log.info("Shop catalogue sync started", { everyMs: TICK_MS, pageSize: PAGE_SIZE });
    setTimeout(tick, 60_000).unref();
    setInterval(tick, TICK_MS).unref();
}
