import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    UpdateDateColumn,
    Index,
} from "typeorm";

/**
 * One buyable variant: a size, a colour, or the single default variant of a
 * product that has no options.
 *
 * `storeVariantId` is the Shopify variant id and is the only field that can
 * actually place an order. Zendrop fulfils from the connected store, and
 * `fulfill_order` matches our line items back to store variants, so a variant
 * without this id is a variant we can display but never ship.
 */
export interface ShopProductVariant {
    /** Supplier SKU. The join key between Zendrop's catalogue and the store. */
    sku: string | null;
    title: string;
    /** Shopify variant id. Required to place and fulfil an order. */
    storeVariantId: string;
    zendropVariantId: number | null;
    wholesale: number;
    /** wholesale + the product's US shipping quote. */
    landedCost: number;
    retail: number;
    image: string | null;
    inStock: boolean;
}

/**
 * A Zendrop catalogue item mirrored locally.
 *
 * Zendrop's catalogue API answers in 5 to 11 seconds, so the storefront can
 * never call it on page load. Rows here are refreshed by the sync job and the
 * shop reads only this table.
 *
 * `retailPrice` is stored rather than derived on read for two reasons: a
 * shopper filters on the retail price, not on Zendrop's wholesale price, and a
 * price must not move between the listing and the basket just because a
 * shipping quote changed mid-session.
 */
@Entity("shop_products")
@Index(["isActive", "retailPrice"])
@Index(["isActive", "categoryId"])
export class ShopProduct {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    /** Zendrop catalogue id. The natural key for syncing. */
    @Column({ type: "integer", unique: true })
    @Index()
    zendropProductId: number;

    // ── link to the connected Shopify store ───────────────────────────
    /**
     * Shopify product id, set once the product exists in the connected store.
     *
     * Null means Zendrop cannot ship it: it only fulfils orders that arrive
     * from a connected store. The shop therefore lists only rows that have
     * this, which is why `isFulfillable` gates every storefront query.
     */
    @Column({ type: "varchar", length: 64, nullable: true })
    @Index()
    shopifyProductId: string | null;

    /** Zendrop import-list id, the handle for re-reading the variant mapping. */
    @Column({ type: "integer", nullable: true })
    importListId: number | null;

    /**
     * Shipping quotes per destination, keyed by ISO country code.
     *
     * A cache, not a source of truth: Zendrop quotes shipping per product per
     * country, and asking them live for every basket line would put a slow
     * third party in the middle of checkout. Filled on first use for a
     * destination and reused after, with `at` so a stale quote can be spotted.
     * `null` for a country means Zendrop offered nothing, which is a real
     * answer and is cached too, so we stop asking.
     */
    @Column({ type: "jsonb", default: () => "'{}'::jsonb" })
    shippingByCountry: Record<string, { cost: number; eta: string | null; at: string } | null>;

    /** Buyable variants with their Shopify ids. Empty until the store sync runs. */
    @Column({ type: "jsonb", default: () => "'[]'::jsonb" })
    variants: ShopProductVariant[];

    /**
     * True only when the product is in the store AND priced AND has at least
     * one variant we can order. Everything the storefront shows is gated on
     * this, so we can never sell something we cannot ship.
     */
    @Column({ type: "boolean", default: false })
    @Index()
    isFulfillable: boolean;

    /**
     * Why this product cannot be sold, in words an admin can act on.
     *
     * Null whenever isFulfillable is true. Without it the dashboard could
     * only report a number, and "155 cannot be shipped" tells the owner
     * nothing about whether that is 155 things to push to the store or 155
     * things Zendrop will never ship.
     */
    @Column({ type: "varchar", length: 120, nullable: true })
    unsellableReason: string | null;

    @Column({ type: "varchar", length: 500 })
    name: string;

    @Column({ type: "text", nullable: true })
    description: string | null;

    @Column({ type: "varchar", length: 1000, nullable: true })
    image: string | null;

    @Column({ type: "jsonb", default: () => "'[]'::jsonb" })
    images: string[];

    // ── money, all USD ────────────────────────────────────────────────
    @Column({ type: "decimal", precision: 10, scale: 2 })
    wholesalePrice: number;

    /** US shipping quote, the reference market for the markup. */
    @Column({ type: "decimal", precision: 10, scale: 2, default: 0 })
    shippingCost: number;

    /** wholesale + shipping, what we pay Zendrop. */
    @Column({ type: "decimal", precision: 10, scale: 2, default: 0 })
    landedCost: number;

    @Column({ type: "decimal", precision: 4, scale: 2, default: 0 })
    multiplier: number;

    /** What the shopper pays. Always ends in .99. */
    @Column({ type: "decimal", precision: 10, scale: 2, default: 0 })
    @Index()
    retailPrice: number;

    // ── catalogue metadata ────────────────────────────────────────────
    @Column({ type: "integer", nullable: true })
    categoryId: number | null;

    @Column({ type: "varchar", length: 255, nullable: true })
    categoryName: string | null;

    @Column({ type: "varchar", length: 255, nullable: true })
    supplierName: string | null;

    @Column({ type: "varchar", length: 8, nullable: true })
    shipsFrom: string | null;

    /**
     * Internal only. Never publish this to a shopper.
     *
     * It is the shipping leg for ONE country, the US pricing baseline, and it
     * excludes the one to three business days (five when busy) before an
     * order is dispatched at all. The storefront used to render it as "Ships
     * in 8 days", which named the wrong event, used the wrong country for
     * everyone outside the US, and left out the dispatch wait. There is no
     * figure here honest enough to print, so nothing is printed and the
     * shopper gets a tracking number instead.
     */
    @Column({ type: "varchar", length: 64, nullable: true })
    estimatedDelivery: string | null;

    @Column({ type: "boolean", default: true })
    inStock: boolean;

    /** Hidden from the shop when false, without deleting the row. */
    @Column({ type: "boolean", default: true })
    isActive: boolean;

    @Column({ type: "timestamp", nullable: true })
    lastSyncedAt: Date | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
