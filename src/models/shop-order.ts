import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    UpdateDateColumn,
    Index,
} from "typeorm";

export enum ShopOrderStatus {
    AWAITING_PAYMENT = "awaiting_payment",
    PAID = "paid",
    PAYMENT_FAILED = "payment_failed",
    CANCELLED = "cancelled",
}

/**
 * Where the goods are, which is NOT the same question as whether the money
 * arrived. Kept separate from `status` so a paid order whose supplier push
 * failed is visibly paid and visibly unfulfilled.
 */
export enum ShopFulfillmentStatus {
    NOT_STARTED = "not_started",
    PUSHED_TO_STORE = "pushed_to_store",
    FULFILLING = "fulfilling",
    SHIPPED = "shipped",
    DELIVERED = "delivered",
    FAILED = "failed",
}

/** One line, priced at the moment of checkout. */
export interface ShopOrderLine {
    productId: string;
    zendropProductId: number;
    name: string;
    image: string | null;
    unitPrice: number;
    quantity: number;
    lineTotal: number;
}

/**
 * A shop order.
 *
 * Deliberately its own table, with no relation to the delivery `orders` table
 * and no reference from any dispatch code. That separation IS the mechanism
 * that stops a shop purchase triggering an instant delivery: stock ships from
 * the supplier on a multi day estimate, so a shop order must never reach a
 * courier queue. There is no field here a dispatcher could read, and nothing
 * creates a delivery Order from one of these.
 *
 * Guest orders are the normal case, so there is no required userId: shopping
 * must work for someone who has never signed in. The row's uuid is the only
 * thing needed to look it up, which makes the id itself the capability token
 * for the confirmation page.
 */
@Entity("shop_orders")
@Index(["status", "createdAt"])
export class ShopOrder {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    /** Short human readable code, shown to the customer and in support. */
    @Column({ type: "varchar", length: 20, unique: true })
    @Index()
    orderNumber: string;

    @Column({ type: "varchar", length: 200 })
    @Index()
    email: string;

    /** Set only when a signed in customer checks out. Guests leave it null. */
    @Column({ type: "uuid", nullable: true })
    userId: string | null;

    @Column({ type: "jsonb" })
    items: ShopOrderLine[];

    @Column({ type: "decimal", precision: 10, scale: 2 })
    subtotal: number;

    /** Shipping is already inside each retail price for the countries we sell to. */
    @Column({ type: "decimal", precision: 10, scale: 2, default: 0 })
    shippingTotal: number;

    @Column({ type: "decimal", precision: 10, scale: 2 })
    total: number;

    @Column({ type: "varchar", length: 3, default: "USD" })
    currency: string;

    @Column({ type: "enum", enum: ShopOrderStatus, default: ShopOrderStatus.AWAITING_PAYMENT })
    @Index()
    status: ShopOrderStatus;

    @Column({ type: "enum", enum: ShopFulfillmentStatus, default: ShopFulfillmentStatus.NOT_STARTED })
    fulfillmentStatus: ShopFulfillmentStatus;

    /** Stripe hosted Checkout session. Unique so a replayed webhook cannot double apply. */
    @Column({ type: "varchar", length: 255, nullable: true, unique: true })
    @Index()
    stripeSessionId: string | null;

    @Column({ type: "varchar", length: 255, nullable: true })
    stripePaymentIntentId: string | null;

    @Column({ type: "timestamp", nullable: true })
    paidAt: Date | null;

    /** Captured by Stripe Checkout, so we never hold card data or type an address. */
    @Column({ type: "jsonb", nullable: true })
    shippingAddress: Record<string, any> | null;

    /** Set once the paid order has been pushed to the Shopify bridge. */
    @Column({ type: "varchar", length: 100, nullable: true })
    shopifyOrderId: string | null;

    @Column({ type: "integer", nullable: true })
    zendropOrderId: number | null;

    @Column({ type: "text", nullable: true })
    fulfillmentError: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
