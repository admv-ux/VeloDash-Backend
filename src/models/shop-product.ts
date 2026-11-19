import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    UpdateDateColumn,
    Index,
} from "typeorm";

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
