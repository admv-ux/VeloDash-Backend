import { Router } from "express";
import { ShopController } from "../controllers/ShopController";
import rateLimit from "express-rate-limit";

const router = Router();
const shop = new ShopController();

/** The application form is open to the internet, so it gets its own tight cap. */
const applicationLimiter = rateLimit({
    windowMs: 60 * 60_000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: "Too many applications from this address. Please try again later." },
});

/**
 * Public storefront catalogue.
 *
 * Deliberately NOT behind apiKeyMiddleware or requireAuth: shopvelodash.com is
 * a public shop and browsing must work for someone who has never signed in.
 * These endpoints expose retail prices and product copy only, never wholesale
 * cost or margin.
 */

/**
 * @openapi
 * /shop/products:
 *   get:
 *     tags: [Shop]
 *     summary: Browse the catalogue
 *     parameters:
 *       - { in: query, name: search, schema: { type: string } }
 *       - { in: query, name: categoryId, schema: { type: integer } }
 *       - { in: query, name: minPrice, schema: { type: number } }
 *       - { in: query, name: maxPrice, schema: { type: number } }
 *       - { in: query, name: sort, schema: { type: string, enum: [price_asc, price_desc, newest, name] } }
 *       - { in: query, name: page, schema: { type: integer } }
 *       - { in: query, name: limit, schema: { type: integer } }
 *     responses:
 *       200: { description: Matching products }
 */
router.get("/products", shop.listProducts);

/**
 * @openapi
 * /shop/categories:
 *   get:
 *     tags: [Shop]
 *     summary: Categories we carry stock in
 *     responses:
 *       200: { description: Category list }
 */
router.get("/categories", shop.getCategories);

/**
 * @openapi
 * /shop/price-range:
 *   get:
 *     tags: [Shop]
 *     summary: Lowest and highest retail price in stock
 *     responses:
 *       200: { description: Price bounds }
 */
router.get("/price-range", shop.getPriceRange);

/**
 * @openapi
 * /shop/products/{id}:
 *   get:
 *     tags: [Shop]
 *     summary: One product
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: The product }
 *       404: { description: Not found }
 */
router.get("/products/:id", shop.getProduct);

/**
 * @openapi
 * /shop/merchant-applications:
 *   post:
 *     tags: [Shop]
 *     summary: Apply to sell on VeloDash
 *     responses:
 *       201: { description: Application received }
 *       400: { description: Missing or invalid details }
 */
router.post("/merchant-applications", applicationLimiter, shop.submitMerchantApplication);

export default router;
