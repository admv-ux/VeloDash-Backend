import { AppDataSource } from "../../db/data-source";
import { MerchantApplication, MerchantApplicationStatus } from "../../models/merchant-application";
import logger from "../../utils/logger";

const log = logger.child({ service: "MerchantApplications" });

export class MerchantApplicationError extends Error {}

/** Trim, cap and reject the obviously invalid. The form is public, so nothing is trusted. */
function clean(value: unknown, max: number): string | null {
    const s = String(value ?? "").trim();
    if (!s) return null;
    return s.slice(0, max);
}

export interface ApplicationInput {
    businessName?: string;
    contactName?: string;
    email?: string;
    phone?: string;
    country?: string;
    productCategory?: string;
    website?: string;
    message?: string;
}

export class MerchantApplicationService {
    private repo = AppDataSource.getRepository(MerchantApplication);

    async submit(input: ApplicationInput): Promise<MerchantApplication> {
        const businessName = clean(input.businessName, 200);
        const contactName = clean(input.contactName, 120);
        const email = clean(input.email, 200)?.toLowerCase() ?? null;

        if (!businessName) throw new MerchantApplicationError("Business name is required");
        if (!contactName) throw new MerchantApplicationError("Your name is required");
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            throw new MerchantApplicationError("A valid email address is required");
        }

        // One open application per business email, so a double submit does not
        // create duplicate work for whoever reviews these.
        const existing = await this.repo.findOne({
            where: { email, status: MerchantApplicationStatus.NEW },
        });
        if (existing) {
            log.info("Duplicate application ignored", { email });
            return existing;
        }

        const application = this.repo.create({
            businessName,
            contactName,
            email,
            phone: clean(input.phone, 40),
            country: clean(input.country, 60),
            productCategory: clean(input.productCategory, 200),
            website: clean(input.website, 300),
            message: clean(input.message, 2000),
            status: MerchantApplicationStatus.NEW,
        });
        await this.repo.save(application);
        log.info("Merchant application received", { id: application.id, businessName });
        return application;
    }

    async list(status?: MerchantApplicationStatus, page = 1, limit = 50) {
        const [rows, total] = await this.repo.findAndCount({
            where: status ? { status } : {},
            order: { createdAt: "DESC" },
            skip: (page - 1) * limit,
            take: limit,
        });
        return { total, page, limit, applications: rows };
    }

    async update(id: string, patch: { status?: MerchantApplicationStatus; adminNotes?: string }) {
        const row = await this.repo.findOne({ where: { id } });
        if (!row) throw new MerchantApplicationError("Application not found");
        if (patch.status) row.status = patch.status;
        if (patch.adminNotes !== undefined) row.adminNotes = clean(patch.adminNotes, 4000);
        await this.repo.save(row);
        return row;
    }
}
