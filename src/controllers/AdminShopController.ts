import { Request, Response } from "express";
import { AppDataSource } from "../db/data-source";
import { ShopProduct } from "../models/shop-product";
import { CatalogSyncService } from "../services/shop/catalog-sync-service";
import { zendropConfigured } from "../services/shop/zendrop-client";
import { retailPriceFor } from "../config/shop-pricing";
import logger from "../utils/logger";

const log = logger.child({ controller: "AdminShop" });

/**
 * Admin side of the shop. Unlike the public catalogue this does expose landed
 * cost, multiplier and margin, which is the whole point of having it.
 */
export class AdminShopController {
    private sync = new CatalogSyncService();
    private productRepo = () => AppDataSource.getRepository(ShopProduct);

    status = async (_req: Request, res: Response) => {
        const repo = this.productRepo();
        const [total, active] = await Promise.all([
            repo.count(),
            repo.count({ where: { isActive: true } }),
        ]);
        const last = await repo.findOne({ where: {}, order: { lastSyncedAt: "DESC" } });
        res.json({
            configured: zendropConfigured(),
            products: { total, active, hidden: total - active },
            lastSyncedAt: last?.lastSyncedAt ?? null,
        });
    };

    syncCategories = async (_req: Request, res: Response) => {
        if (!zendropConfigured()) {
            res.status(503).json({ message: "Zendrop is not configured" });
            return;
        }
        try {
            res.json({ synced: await this.sync.syncCategories() });
        } catch (e) {
            log.error("syncCategories failed", { error: (e as Error).message });
            res.status(502).json({ message: (e as Error).message });
        }
    };

    syncCategory = async (req: Request, res: Response) => {
        if (!zendropConfigured()) {
            res.status(503).json({ message: "Zendrop is not configured" });
            return;
        }
        const categoryId = Number(req.params.categoryId);
        if (!Number.isInteger(categoryId)) {
            res.status(400).json({ message: "categoryId must be an integer" });
            return;
        }
        const page = Number(req.query.page) || 1;
        const limit = Math.min(50, Number(req.query.limit) || 50);
        try {
            res.json(await this.sync.syncCategoryPage(categoryId, page, limit));
        } catch (e) {
            log.error("syncCategory failed", { categoryId, error: (e as Error).message });
            res.status(502).json({ message: (e as Error).message });
        }
    };

    /** Full rows including cost and margin, for the admin table. */
    listProducts = async (req: Request, res: Response) => {
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.min(200, Number(req.query.limit) || 50);
        const qb = this.productRepo().createQueryBuilder("p").orderBy("p.updatedAt", "DESC");
        if (req.query.search) qb.andWhere("p.name ILIKE :s", { s: `%${req.query.search}%` });
        const [rows, total] = await qb.skip((page - 1) * limit).take(limit).getManyAndCount();
        res.json({
            total,
            page,
            limit,
            products: rows.map(p => ({
                id: p.id,
                zendropProductId: p.zendropProductId,
                name: p.name,
                image: p.image,
                wholesalePrice: Number(p.wholesalePrice),
                shippingCost: Number(p.shippingCost),
                landedCost: Number(p.landedCost),
                multiplier: Number(p.multiplier),
                retailPrice: Number(p.retailPrice),
                margin: Math.round((Number(p.retailPrice) - Number(p.landedCost)) * 100) / 100,
                categoryName: p.categoryName,
                inStock: p.inStock,
                isActive: p.isActive,
                lastSyncedAt: p.lastSyncedAt,
            })),
        });
    };

    /**
     * Hide a product, or override its price. An override is clamped to landed
     * cost so the shop can never be configured to sell at a loss by accident.
     */
    updateProduct = async (req: Request, res: Response) => {
        const repo = this.productRepo();
        const product = await repo.findOne({ where: { id: req.params.id } });
        if (!product) {
            res.status(404).json({ message: "Product not found" });
            return;
        }
        const { isActive, retailPrice } = req.body || {};
        if (typeof isActive === "boolean") product.isActive = isActive;
        if (retailPrice !== undefined) {
            const price = Number(retailPrice);
            if (!Number.isFinite(price) || price <= Number(product.landedCost)) {
                res.status(400).json({
                    message: `retailPrice must be above the landed cost of ${Number(product.landedCost).toFixed(2)}`,
                });
                return;
            }
            product.retailPrice = price;
        }
        await repo.save(product);
        res.json({ product: { id: product.id, isActive: product.isActive, retailPrice: Number(product.retailPrice) } });
    };

    /** Recompute every stored price from the current rule, after a tier change. */
    repriceAll = async (_req: Request, res: Response) => {
        const repo = this.productRepo();
        const all = await repo.find();
        let changed = 0;
        for (const p of all) {
            const priced = retailPriceFor(Number(p.wholesalePrice), Number(p.shippingCost));
            if (Number(p.retailPrice) !== priced.retail || Number(p.multiplier) !== priced.multiplier) {
                p.landedCost = priced.cost;
                p.multiplier = priced.multiplier;
                p.retailPrice = priced.retail;
                await repo.save(p);
                changed++;
            }
        }
        log.info("Repriced catalogue", { examined: all.length, changed });
        res.json({ examined: all.length, changed });
    };
}
