import { Entity, PrimaryGeneratedColumn, Column, UpdateDateColumn, Index } from "typeorm";

/**
 * A Zendrop catalogue category, mirrored so the storefront filter renders
 * instantly instead of waiting on a multi second upstream call.
 */
@Entity("shop_categories")
export class ShopCategory {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    @Column({ type: "integer", unique: true })
    @Index()
    zendropCategoryId: number;

    @Column({ type: "varchar", length: 255 })
    name: string;

    @Column({ type: "integer", nullable: true })
    parentId: number | null;

    /** How many products Zendrop reports in this category. */
    @Column({ type: "integer", default: 0 })
    productCount: number;

    /** Only categories we have actually synced products for are offered. */
    @Column({ type: "boolean", default: false })
    isCarried: boolean;

    @UpdateDateColumn()
    updatedAt: Date;
}
