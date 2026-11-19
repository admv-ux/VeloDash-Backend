import { callZendropTool, ZendropError, ZendropNotConfiguredError } from "../src/services/shop/zendrop-client";

/**
 * Zendrop rate limits a sustained catalogue sync. Losing a page to a 429 means
 * silent gaps in the shop, so the retry behaviour is pinned here.
 */

const okBody = (payload: any) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } }),
});

const rateLimited = (retryAfter: string | null = null) => ({
    ok: false,
    status: 429,
    headers: { get: (h: string) => (h.toLowerCase() === "retry-after" ? retryAfter : null) },
    text: async () => "rate limited",
});

const originalFetch = global.fetch;
beforeEach(() => {
    process.env.ZENDROP_API_ACCESS_TOKEN = "test-token";
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
});
afterEach(() => {
    jest.useRealTimers();
    global.fetch = originalFetch;
});

/** Run a promise that sleeps on fake timers to completion. */
async function runWithTimers<T>(p: Promise<T>): Promise<T> {
    const settled = p.then(v => ({ v }), e => ({ e }));
    // Each retry needs its microtasks drained before its sleep timer exists,
    // so pump generously: 4 retries with growing backoff is ~15s of fake time.
    for (let i = 0; i < 80; i++) {
        await Promise.resolve();
        await Promise.resolve();
        jest.runOnlyPendingTimers();
    }
    const r: any = await settled;
    if ("e" in r) throw r.e;
    return r.v;
}

describe("callZendropTool", () => {
    it("unwraps the MCP text envelope into an object", async () => {
        global.fetch = jest.fn().mockResolvedValue(okBody({ total: 2, products: [1, 2] })) as any;
        const out = await runWithTimers(callZendropTool("get_catalog_products"));
        expect(out).toEqual({ total: 2, products: [1, 2] });
    });

    it("retries a 429 and then succeeds", async () => {
        const fetchMock = jest.fn()
            .mockResolvedValueOnce(rateLimited())
            .mockResolvedValueOnce(rateLimited())
            .mockResolvedValueOnce(okBody({ ok: true }));
        global.fetch = fetchMock as any;

        const out = await runWithTimers(callZendropTool("get_catalog_categories"));

        expect(out).toEqual({ ok: true });
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("gives up after the retry budget instead of looping forever", async () => {
        const fetchMock = jest.fn().mockResolvedValue(rateLimited());
        global.fetch = fetchMock as any;

        await expect(runWithTimers(callZendropTool("get_catalog_categories"))).rejects.toBeInstanceOf(ZendropError);
        // first attempt plus MAX_RETRIES
        expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    it("does not retry a non rate limit error", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: false, status: 500, headers: { get: () => null }, text: async () => "boom",
        });
        global.fetch = fetchMock as any;

        await expect(runWithTimers(callZendropTool("get_order"))).rejects.toBeInstanceOf(ZendropError);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("surfaces a JSON-RPC error rather than returning junk", async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true, status: 200, headers: { get: () => null },
            text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "Invalid Request" } }),
        }) as any;

        await expect(runWithTimers(callZendropTool("whatever"))).rejects.toThrow("Invalid Request");
    });

    it("refuses to call at all when no token is set", async () => {
        delete process.env.ZENDROP_API_ACCESS_TOKEN;
        await expect(callZendropTool("get_catalog_products")).rejects.toBeInstanceOf(ZendropNotConfiguredError);
    });
});
