import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from "typeorm";

export enum MerchantApplicationStatus {
    NEW = "new",
    REVIEWING = "reviewing",
    APPROVED = "approved",
    REJECTED = "rejected",
}

/**
 * A "Sell with VeloDash" enquiry from the public shop.
 *
 * Deliberately not tied to a user account: an applicant does not have one yet,
 * and requiring signup before they can even ask would lose most of them.
 */
@Entity("merchant_applications")
export class MerchantApplication {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    @Column({ type: "varchar", length: 200 })
    businessName: string;

    @Column({ type: "varchar", length: 120 })
    contactName: string;

    @Column({ type: "varchar", length: 200 })
    @Index()
    email: string;

    @Column({ type: "varchar", length: 40, nullable: true })
    phone: string | null;

    @Column({ type: "varchar", length: 60, nullable: true })
    country: string | null;

    @Column({ type: "varchar", length: 200, nullable: true })
    productCategory: string | null;

    @Column({ type: "varchar", length: 300, nullable: true })
    website: string | null;

    @Column({ type: "text", nullable: true })
    message: string | null;

    @Column({
        type: "enum",
        enum: MerchantApplicationStatus,
        default: MerchantApplicationStatus.NEW,
    })
    @Index()
    status: MerchantApplicationStatus;

    @Column({ type: "text", nullable: true })
    adminNotes: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
