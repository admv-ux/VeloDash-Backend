import { MerchantApplicationService, MerchantApplicationError } from "../src/services/shop/merchant-application-service";
import { MerchantApplicationStatus } from "../src/models/merchant-application";

/**
 * This form is open to the internet with no account behind it, so validation
 * and the duplicate guard are the only things standing between it and junk.
 */
function buildService(existing: any = null) {
    const svc = new MerchantApplicationService();
    const saved: any[] = [];
    (svc as any).repo = {
        findOne: jest.fn().mockResolvedValue(existing),
        create: jest.fn().mockImplementation((d: any) => ({ ...d })),
        save: jest.fn().mockImplementation(async (e: any) => { saved.push({ ...e }); return e; }),
        findAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    return { svc, saved };
}

const valid = { businessName: "Kofi Foods", contactName: "Kofi A", email: "Kofi@Example.com" };

describe("submit", () => {
    it("accepts a complete application and lowercases the email", async () => {
        const { svc, saved } = buildService();
        const row = await svc.submit({ ...valid, phone: "+233501234567", country: "GH" });
        expect(row.status).toBe(MerchantApplicationStatus.NEW);
        expect(saved[0]).toMatchObject({
            businessName: "Kofi Foods",
            contactName: "Kofi A",
            email: "kofi@example.com",
            phone: "+233501234567",
            country: "GH",
        });
    });

    it("rejects a missing business name", async () => {
        const { svc } = buildService();
        await expect(svc.submit({ ...valid, businessName: "   " })).rejects.toBeInstanceOf(MerchantApplicationError);
    });

    it("rejects a missing contact name", async () => {
        const { svc } = buildService();
        await expect(svc.submit({ ...valid, contactName: "" })).rejects.toBeInstanceOf(MerchantApplicationError);
    });

    it("rejects an address that is not an email", async () => {
        const { svc } = buildService();
        for (const email of ["", "nope", "a@b", "a b@c.com"]) {
            await expect(svc.submit({ ...valid, email })).rejects.toBeInstanceOf(MerchantApplicationError);
        }
    });

    it("caps long input instead of storing it whole", async () => {
        const { svc, saved } = buildService();
        await svc.submit({ ...valid, message: "x".repeat(5000) });
        expect(saved[0].message).toHaveLength(2000);
    });

    it("returns the open application instead of creating a duplicate", async () => {
        const open = { id: "existing-1", status: MerchantApplicationStatus.NEW };
        const { svc, saved } = buildService(open);
        const row = await svc.submit(valid);
        expect(row).toBe(open);
        expect(saved).toEqual([]);
    });

    it("stores optional fields as null rather than empty strings", async () => {
        const { svc, saved } = buildService();
        await svc.submit(valid);
        expect(saved[0].phone).toBeNull();
        expect(saved[0].website).toBeNull();
        expect(saved[0].message).toBeNull();
    });
});
