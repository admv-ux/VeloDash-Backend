import logger from "../utils/logger";
import { StoreSyncService } from "../services/shop/store-sync-service";
import { zendropConfigured } from "../services/shop/zendrop-client";

const log = logger.child({ service: "ShopStoreSync" });

/**
 * Keeps the sellable catalogue in step with the Shopify store.
 *
 * This is not the same job as `shop-catalog-sync`. That one trawls Zendrop's
 * 1.3M row catalogue for products we might one day carry; this one re-reads
 * the ~125 that are actually in the store and can therefore be shipped. Only
 * the second decides what the shop displays.
 *
 * It matters on a schedule rather than on demand because the store changes
 * underneath us: a product pulled upstream, a variant that sells out or a
 * supplier price rise all leave the shop advertising something it can no
 * longer honour. A full pass delists whatever has left the store.
 *
 * On by default, unlike the catalogue trawl, because the cost of it NOT
 * running is selling a parcel nobody can dispatch. Set
 * SHOP_STORE_SYNC_ENABLED=false to stop it.
 */

/**
 * Twice a day. A full pass is roughly three hundred rate limited upstream
 * calls and takes about ten minutes, so this is as often as is polite and far
 * more often than the store actually changes.
 */
const TICK_MS = Number(process.env.SHOP_STORE_SYNC_INTERVAL_MS) || 12 * 60 * 60 * 1000;

/** Long enough after boot that it never competes with startup. */
const FIRST_RUN_MS = 5 * 60 * 1000;

let running = false;

export function startShopStoreSync(): void {
    if (process.env.SHOP_STORE_SYNC_ENABLED === "false") {
        log.info("Shop store sync is disabled");
        return;
    }
    if (!zendropConfigured()) {
        log.warn("Shop store sync wanted but Zendrop is not configured");
        return;
    }

    const service = new StoreSyncService();

    const tick = async () => {
        // A pass can outlast a short interval, and two concurrent passes would
        // both be writing the same rows and both be eating the same quota.
        if (running) return;
        running = true;
        try {
            const result = await service.syncStore();
            log.info("Shop store sync tick", result);
        } catch (e) {
            log.warn("Shop store sync tick failed", { error: (e as Error).message });
        } finally {
            running = false;
        }
    };

    log.info("Shop store sync started", { everyMs: TICK_MS });
    setTimeout(tick, FIRST_RUN_MS).unref();
    setInterval(tick, TICK_MS).unref();
}
