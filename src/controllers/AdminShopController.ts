import { Request, Response } from "express";
import { AppDataSource } from "../db/data-source";
import { ShopProduct } from "../models/shop-product";
import { ShopOrder, ShopOrderStatus, ShopFulfillmentStatus } from "../models/shop-order";
import { Like } from "typeorm";
import { CatalogSyncService } from "../services/shop/catalog-sync-service";
import { zendropConfigured } from "../services/shop/zendrop-client";
import { retailPriceFor } from "../config/shop-pricing";
import { MerchantApplicationService, MerchantApplicationError } from "../services/shop/merchant-application-service";
import { MerchantApplicationStatus } from "../models/merchant-application";
import logger from "../utils/logger";

const log = logger.child({ controller: "AdminShop" });

/**
 * Admin side of the shop. Unlike the public catalogue this does expose landed
 * cost, multiplier and margin, which is the whole point of having it.
 */
export class AdminShopController {
    private sync = new CatalogSyncService();
    private applications = new MerchantApplicationService();
    private productRepo = () => AppDataSource.getRepository(ShopProduct);
    private orderRepo = () => AppDataSource.getRepository(ShopOrder);

    /**
     * Orders placed on the public shop. Shown in full, including the email and
     * address, because that is what support needs to answer "where is my
     * parcel".
     */
    listOrders = async (req: Request, res: Response) => {
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.min(200, Number(req.query.limit) || 50);
        const where: any = {};
        if (req.query.status) where.status = req.query.status as ShopOrderStatus;
        if (req.query.fulfillmentStatus) where.fulfillmentStatus = req.query.fulfillmentStatus as ShopFulfillmentStatus;
        if (req.query.search) where.orderNumber = Like(`%${String(req.query.search).toUpperCase()}%`);

        const [orders, total] = await this.orderRepo().findAndCount({
            where,
            order: { createdAt: "DESC" },
            skip: (page - 1) * limit,
            take: limit,
        });
        res.json({ total, page, limit, orders });
    };

    /** Revenue at a glance, split by the two statuses that matter. */
    orderSummary = async (_req: Request, res: Response) => {
        const repo = this.orderRepo();
        const row = await repo
            .createQueryBuilder("o")
            .select("COUNT(*)::int", "orders")
            .addSelect("COUNT(*) FILTER (WHERE o.status = 'paid')::int", "paidOrders")
            .addSelect("COALESCE(SUM(o.total) FILTER (WHERE o.status = 'paid'), 0)", "paidRevenue")
            .addSelect("COUNT(*) FILTER (WHERE o.status = 'awaiting_payment')::int", "awaitingPayment")
            .addSelect("COUNT(*) FILTER (WHERE o.status = 'paid' AND o.\"fulfillmentStatus\" = 'not_started')::int", "awaitingFulfilment")
            .getRawOne();
        res.json({
            orders: Number(row?.orders || 0),
            paidOrders: Number(row?.paidOrders || 0),
            paidRevenue: Number(row?.paidRevenue || 0),
            awaitingPayment: Number(row?.awaitingPayment || 0),
            awaitingFulfilment: Number(row?.awaitingFulfilment || 0),
        });
    };

    /**
     * Move an order's fulfilment along by hand. Deliberately cannot touch
     * `status`: whether the money arrived is Stripe's answer, not an admin's.
     */
    updateOrder = async (req: Request, res: Response) => {
        const order = await this.orderRepo().findOne({ where: { id: req.params.id } });
        if (!order) {
            res.status(404).json({ message: "Order not found" });
            return;
        }
        const next = req.body?.fulfillmentStatus;
        if (next) {
            if (!Object.values(ShopFulfillmentStatus).includes(next)) {
                res.status(400).json({ message: "Unknown fulfilment status" });
                return;
            }
            order.fulfillmentStatus = next;
        }
        if (req.body?.fulfillmentError !== undefined) {
            order.fulfillmentError = req.body.fulfillmentError
                ? String(req.body.fulfillmentError).slice(0, 500)
                : null;
        }
        if (req.body?.shopifyOrderId !== undefined) {
            order.shopifyOrderId = req.body.shopifyOrderId ? String(req.body.shopifyOrderId).slice(0, 100) : null;
        }
        await this.orderRepo().save(order);
        log.info("Shop order updated by admin", { orderId: order.id, fulfillmentStatus: order.fulfillmentStatus });
        res.json({ order });
    };

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

    listApplications = async (req: Request, res: Response) => {
        const status = req.query.status as MerchantApplicationStatus | undefined;
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.min(200, Number(req.query.limit) || 50);
        res.json(await this.applications.list(status, page, limit));
    };

    updateApplication = async (req: Request, res: Response) => {
        try {
            const row = await this.applications.update(req.params.id, {
                status: req.body?.status,
                adminNotes: req.body?.adminNotes,
            });
            res.json({ application: row });
        } catch (e) {
            if (e instanceof MerchantApplicationError) {
                res.status(404).json({ message: e.message });
                return;
            }
            log.error("updateApplication failed", { error: (e as Error).message });
            res.status(500).json({ message: "Could not update the application" });
        }
    };
}
