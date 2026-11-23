import { AppDataSource } from "../../db/data-source";
import { ShopProduct, ShopProductVariant } from "../../models/shop-product";
import { ShopCategory } from "../../models/shop-category";

/**
 * Reads the mirrored catalogue. Everything here hits our own Postgres, never
 * Zendrop, because upstream takes 5 to 11 seconds per call.
 *
 * Every query is gated on BOTH isActive and isFulfillable. isActive is the
 * admin's switch; isFulfillable is the sync's answer to "does this exist in
 * the Shopify store Zendrop ships from". Listing a product that fails the
 * second one means taking money for a parcel that can never be dispatched,
 * so the gate lives here rather than in each caller.
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
    /**
     * How many buyable variants there are. The grid only needs to know
     * whether there is a choice to make, and shipping the full arrays with a
     * listing was 86% of the payload: one product alone has 100 variants.
     */
    variantCount: number;
    /** Cheapest-first, and only on the detail response. */
    variants?: CatalogVariantItem[];
}

/** A variant as the shopper sees it. Cost and the Shopify id stay server side. */
export interface CatalogVariantItem {
    id: string;
    title: string;
    price: number;
    image: string | null;
    inStock: boolean;
}

const MAX_LIMIT = 60;

function toItem(p: ShopProduct, withVariants = false): CatalogItem {
    const variants = toVariants(p.variants);
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
        variantCount: variants.length,
        ...(withVariants ? { variants } : {}),
    };
}

/**
 * The Shopify variant id doubles as the public variant id. It is not a
 * secret: it appears in any Shopify storefront, and using it directly means
 * the basket carries the exact id that fulfilment needs, with no second
 * lookup table to drift out of step.
 */
function toVariants(variants: ShopProductVariant[] | null): CatalogVariantItem[] {
    return (variants || [])
        .filter((v) => v && v.storeVariantId)
        .map((v) => ({
            id: v.storeVariantId,
            title: v.title,
            price: Number(v.retail),
            image: v.image,
            inStock: v.inStock !== false,
        }))
        .sort((a, b) => a.price - b.price);
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
            .where("p.isActive = true AND p.isFulfillable = true");

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
        return { total, page, limit, products: rows.map((r) => toItem(r)) };
    }

    async getById(id: string): Promise<(CatalogItem & { description: string | null }) | null> {
        const p = await this.productRepo.findOne({ where: { id, isActive: true, isFulfillable: true } });
        if (!p) return null;
        return { ...toItem(p, true), description: p.description };
    }

    /** Only categories we actually carry stock in, so no filter leads to an empty grid. */
    async categories(): Promise<{ id: number; name: string; parentId: number | null; count: number }[]> {
        const rows = await this.categoryRepo.find({ where: { isCarried: true }, order: { name: "ASC" } });
        const counts = await this.productRepo
            .createQueryBuilder("p")
            .select("p.categoryId", "categoryId")
            .addSelect("COUNT(*)::int", "count")
            .where("p.isActive = true AND p.isFulfillable = true")
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
            .where("p.isActive = true AND p.isFulfillable = true")
            .getRawOne();
        return { min: Number(row?.min || 0), max: Number(row?.max || 0) };
    }
}
