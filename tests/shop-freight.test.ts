import { freightProblem, DEFAULT_FREIGHT_LIMITS } from "../src/config/shop-freight";

/**
 * Real quotes from the catalogue, because the rule exists to deal with real
 * ones. Zendrop priced a 36.27 gaming chair at 1,010.88 to ship and the
 * listing came out at 1,850.99, which is arithmetically correct and
 * commercially nonsense.
 */

const ok = (w: number, s: number) => expect(freightProblem(w, s)).toBeNull();
const bad = (w: number, s: number) => expect(freightProblem(w, s)).not.toBeNull();

describe("freight we refuse to carry", () => {
    it("refuses the gaming chair", () => {
        bad(36.27, 1010.88);
        expect(freightProblem(36.27, 1010.88)).toContain("1010.88");
    });

    it("refuses the rest of the furniture and gym tail", () => {
        bad(79.98, 437.18);  // folding mountain bike
        bad(75.27, 306.33);  // office chair
        bad(14.02, 87.81);   // weighted blanket
        bad(23.29, 105.03);  // flat mop
    });

    it("refuses a cheap thing with courier-sized freight", () => {
        // 89 cent corkscrew, 25.56 to ship, was listed at 57.99.
        bad(0.89, 25.56);
        bad(1.72, 44.77);    // water purifier
        bad(2.23, 31.22);    // yoga mat
    });

    it("keeps the ordinary catalogue, where freight is just postage", () => {
        ok(2.65, 6.34);      // commuter bag, sells at 24.99
        ok(2.23, 5.32);      // dog scarf, ratio 2.4 and perfectly fine
        ok(3.81, 4.89);      // album keychain
        ok(7.99, 13.68);     // trousers
        ok(0.5, 12);         // cheap item, ordinary parcel, under the floor
    });

    it("keeps a genuinely expensive product that ships cheaply", () => {
        // An 823 dollar laptop is a real product, not a freight problem, and
        // a cap on shipping is what tells the two apart.
        ok(465.66, 0);
        ok(391.0, 0);
        ok(422.36, 0);
    });

    it("applies the cap before the ratio, so heavy goods go whatever they cost", () => {
        // Freight under four times the goods but still over the cap.
        bad(171.8, 150.62);
        bad(128.84, 115.1);
    });

    it("leaves the floor alone so a small parcel is never judged on ratio", () => {
        ok(1, 19.99);
        bad(1, 20.01);
    });

    it("honours limits the admin has changed", () => {
        const strict = { maxShippingUsd: 10, maxShippingRatio: 2 };
        expect(freightProblem(2.65, 6.34, strict)).toBeNull();   // still under the cap
        expect(freightProblem(2.65, 12, strict)).not.toBeNull(); // over it
        const loose = { maxShippingUsd: 2000, maxShippingRatio: 100 };
        expect(freightProblem(36.27, 1010.88, loose)).toBeNull();
    });

    it("treats a zero or missing limit as no limit rather than refusing everything", () => {
        expect(freightProblem(10, 500, { maxShippingUsd: 0, maxShippingRatio: 0 })).toBeNull();
    });

    it("does not divide by a zero product price", () => {
        // No goods price means nothing to compare against; the cap still applies.
        expect(freightProblem(0, 5)).toBeNull();
        expect(freightProblem(0, 500)).not.toBeNull();
    });

    it("is the limit pair the catalogue was tuned on", () => {
        expect(DEFAULT_FREIGHT_LIMITS).toEqual({ maxShippingUsd: 50, maxShippingRatio: 4 });
    });
});
