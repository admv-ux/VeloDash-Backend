import { AppDataSource } from "../../db/data-source";
import { ShopProduct } from "../../models/shop-product";
import { ShopCategory } from "../../models/shop-category";

/**
 * Reads the mirrored catalogue. Everything here hits our own Postgres, never
 * Zendrop, because upstream takes 5 to 11 seconds per call.
 */

export interface CatalogQuery {
    search?: string;
    categoryId?: number;
    minPrice?: number;
    maxPrice?: number;
    sort?: "price_asc" | "price_desc" | "newest" | "name";
    page?: number;
    limit?: number;
}

/** What the storefront renders. Deliberately excludes cost and margin. */
export interface CatalogItem {
    id: string;
    name: string;
    image: string | null;
    images: string[];
    price: number;
    currency: "USD";
    categoryId: number | null;
    categoryName: string | null;
    inStock: boolean;
    estimatedDelivery: string | null;
}

const MAX_LIMIT = 60;

function toItem(p: ShopProduct): CatalogItem {
    return {
        id: p.id,
        name: p.name,
        image: p.image,
        images: p.images || [],
        price: Number(p.retailPrice),
        currency: "USD",
        categoryId: p.categoryId,
        categoryName: p.categoryName,
        inStock: p.inStock,
        estimatedDelivery: p.estimatedDelivery,
    };
}

export class ShopCatalogService {
    private productRepo = AppDataSource.getRepository(ShopProduct);
    private categoryRepo = AppDataSource.getRepository(ShopCategory);

    /**
     * Filter and page the catalogue. The price filter runs against the RETAIL
     * price, which is what the shopper sees; Zendrop's own filter works on
     * wholesale and would surprise people.
     */
    async list(query: CatalogQuery): Promise<{ total: number; page: number; limit: number; products: CatalogItem[] }> {
        const page = Math.max(1, Number(query.page) || 1);
        const limit = Math.min(MAX_LIMIT, Math.max(1, Number(query.limit) || 24));

        const qb = this.productRepo.createQueryBuilder("p")
            .where("p.isActive = true");

        if (query.search) {
            qb.andWhere("p.name ILIKE :search", { search: `%${query.search}%` });
        }
        if (query.categoryId) {
            qb.andWhere("p.categoryId = :categoryId", { categoryId: query.categoryId });
        }
        if (query.minPrice !== undefined) {
            qb.andWhere("p.retailPrice >= :minPrice", { minPrice: query.minPrice });
        }
        if (query.maxPrice !== undefined) {
            qb.andWhere("p.retailPrice <= :maxPrice", { maxPrice: query.maxPrice });
        }

        switch (query.sort) {
            case "price_asc": qb.orderBy("p.retailPrice", "ASC"); break;
            case "price_desc": qb.orderBy("p.retailPrice", "DESC"); break;
            case "name": qb.orderBy("p.name", "ASC"); break;
            default: qb.orderBy("p.createdAt", "DESC");
        }
        // A stable tiebreak, so paging cannot repeat or drop a row.
        qb.addOrderBy("p.id", "ASC");

        const [rows, total] = await qb.skip((page - 1) * limit).take(limit).getManyAndCount();
        return { total, page, limit, products: rows.map(toItem) };
    }

    async getById(id: string): Promise<(CatalogItem & { description: string | null }) | null> {
        const p = await this.productRepo.findOne({ where: { id, isActive: true } });
        if (!p) return null;
        return { ...toItem(p), description: p.description };
    }

    /** Only categories we actually carry stock in, so no filter leads to an empty grid. */
    async categories(): Promise<{ id: number; name: string; parentId: number | null; count: number }[]> {
        const rows = await this.categoryRepo.find({ where: { isCarried: true }, order: { name: "ASC" } });
        const counts = await this.productRepo
            .createQueryBuilder("p")
            .select("p.categoryId", "categoryId")
            .addSelect("COUNT(*)::int", "count")
            .where("p.isActive = true")
            .groupBy("p.categoryId")
            .getRawMany();
        const byId = new Map(counts.map(c => [Number(c.categoryId), Number(c.count)]));
        return rows
            .map(c => ({ id: c.zendropCategoryId, name: c.name, parentId: c.parentId, count: byId.get(c.zendropCategoryId) || 0 }))
            .filter(c => c.count > 0);
    }

    /** The price slider needs real bounds, not guessed ones. */
    async priceRange(): Promise<{ min: number; max: number }> {
        const row = await this.productRepo
            .createQueryBuilder("p")
            .select("MIN(p.retailPrice)", "min")
            .addSelect("MAX(p.retailPrice)", "max")
            .where("p.isActive = true")
            .getRawOne();
        return { min: Number(row?.min || 0), max: Number(row?.max || 0) };
    }
}
