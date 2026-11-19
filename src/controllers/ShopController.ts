import { Request, Response } from "express";
import { ShopCatalogService } from "../services/shop/shop-catalog-service";
import { MerchantApplicationService, MerchantApplicationError } from "../services/shop/merchant-application-service";
import logger from "../utils/logger";

const log = logger.child({ controller: "Shop" });

/** Public storefront reads. No auth: browsing must not require an account. */
export class ShopController {
    private catalog = new ShopCatalogService();
    private applications = new MerchantApplicationService();

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
