import { ProductService } from "../src/services/product-service";

/**
 * product.category is free text a merchant typed; the category slugs it is
 * matched against are lower case. 190 of the 238 live listings were stored
 * as "Marketplace", "Food" or "Pharmacy" and therefore matched nothing, so
 * four out of every five products were invisible in every category filtered
 * screen in the app. The match must never be case sensitive again.
 */

function harness(slugs: string[]) {
    const svc = Object.create(ProductService.prototype) as any;
    const wheres: Array<{ sql: string; params: any }> = [];
    const qb: any = {
        leftJoinAndSelect: () => qb,
        where: () => qb,
        andWhere: (sql: string, params?: any) => {
            wheres.push({ sql, params });
            return qb;
        },
        orderBy: () => qb,
        addOrderBy: () => qb,
        skip: () => qb,
        take: () => qb,
        getManyAndCount: async () => [[], 0],
    };
    svc.productRepo = { createQueryBuilder: () => qb };
    svc.productCategoryRepo = { find: async () => slugs.map((slug) => ({ slug })) };
    return { svc, wheres };
}

const categoryClause = (wheres: Array<{ sql: string; params: any }>) =>
    wheres.find((w) => w.sql.includes("category"));

describe("filtering products by category", () => {
    it("lowercases both sides for a single category", async () => {
        const { svc, wheres } = harness(["marketplace"]);
        await svc.getProducts({ category: "marketplace" });
        const clause = categoryClause(wheres);
        expect(clause!.sql).toContain("LOWER(product.category)");
        expect(clause!.params.category).toBe("marketplace");
    });

    it("lowercases every slug when a type expands to several", async () => {
        const { svc, wheres } = harness(["Marketplace", "Food", "Pharmacy"]);
        await svc.getProducts({ category: "product" });
        const clause = categoryClause(wheres);
        expect(clause!.sql).toContain("LOWER(product.category)");
        expect(clause!.params.categorySlugs).toEqual(["marketplace", "food", "pharmacy"]);
    });

    it("matches a Title Case slug that is not a known type", async () => {
        const { svc, wheres } = harness([]);
        await svc.getProducts({ category: "Marketplace" });
        const clause = categoryClause(wheres);
        expect(clause!.sql).toContain("LOWER(product.category)");
        expect(clause!.params.category).toBe("marketplace");
    });

    it("adds no category clause at all when none is asked for", async () => {
        const { svc, wheres } = harness(["marketplace"]);
        await svc.getProducts({});
        expect(categoryClause(wheres)).toBeUndefined();
    });
});
