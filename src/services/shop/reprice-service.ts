import { AppDataSource } from "../../db/data-source";
import { ShopProduct } from "../../models/shop-product";
import { retailPriceFor, PricingPolicy } from "../../config/shop-pricing";
import { loadPricingPolicy } from "./pricing-policy";
import logger from "../../utils/logger";

const log = logger.child({ service: "ShopReprice" });

export interface RepriceResult {
    examined: number;
    /** Rows with no supplier price, which cannot be marked up at all. */
    skipped: number;
    changed: number;
    raised: number;
    lowered: number;
    policy: PricingPolicy;
    averageBefore: number;
    averageAfter: number;
}

/**
 * Recompute every shelf price from what is already stored.
 *
 * Prices live on the product rows, so changing the duty or card fee rate in
 * settings moves nothing until this runs. It touches no upstream API: the
 * goods price and the shipping quote are read from the row, and only the
 * parts we decide are recomputed.
 *
 * Variants are repriced too. The grid lists the cheapest variant and the
 * product page sells from the rest, so repricing the product alone would
 * show one price and charge another.
 */
export class ShopRepriceService {
    private productRepo = AppDataSource.getRepository(ShopProduct);

    async repriceAll(): Promise<RepriceResult> {
        const policy = await loadPricingPolicy();
        const all = await this.productRepo.find();

        let changed = 0;
        let raised = 0;
        let lowered = 0;
        let before = 0;
        let after = 0;

        let skipped = 0;

        for (const p of all) {
            // A row with no supplier price is one Zendrop would not quote at
            // all. There is nothing to mark up, and pricing it anyway puts a
            // 99 cent figure in the admin beside a product we cannot ship.
            if (!(Number(p.wholesalePrice) > 0)) {
                skipped++;
                continue;
            }
            const shipping = Number(p.shippingCost) || 0;
            const priced = retailPriceFor(Number(p.wholesalePrice), shipping, policy);

            const previous = p.variants || [];
            const variants = previous.map((v) => {
                const vp = retailPriceFor(Number(v.wholesale), shipping, policy);
                return { ...v, landedCost: vp.cost, retail: vp.retail };
            });

            const wasRetail = Number(p.retailPrice);
            const variantsMoved = variants.some((v, i) => v.retail !== Number(previous[i]?.retail));
            const settled =
                wasRetail === priced.retail &&
                Number(p.multiplier) === priced.multiplier &&
                Number(p.landedCost) === priced.cost &&
                !variantsMoved;
            if (settled) continue;

            p.dutyCost = priced.duty;
            p.processingFee = priced.processing;
            p.landedCost = priced.cost;
            p.multiplier = priced.multiplier;
            p.retailPrice = priced.retail;
            p.variants = variants;
            await this.productRepo.save(p);

            changed++;
            if (priced.retail > wasRetail) raised++;
            if (priced.retail < wasRetail) lowered++;
            before += wasRetail;
            after += priced.retail;
        }

        const result: RepriceResult = {
            examined: all.length,
            skipped,
            changed,
            raised,
            lowered,
            policy,
            averageBefore: changed ? Math.round((before / changed) * 100) / 100 : 0,
            averageAfter: changed ? Math.round((after / changed) * 100) / 100 : 0,
        };
        log.info("Repriced catalogue", result);
        return result;
    }
}
