import logger from "../../utils/logger";

const log = logger.child({ service: "ZendropClient" });

/**
 * Zendrop MCP client.
 *
 * Zendrop support describes a REST API taking {"action": "..."} bodies. That
 * does not exist. The endpoint is an MCP JSON-RPC 2.0 server and rejects
 * anything else with -32600 "Invalid JSON-RPC version". Everything here speaks
 * JSON-RPC and calls tools by the names `tools/list` actually returns.
 */

export const ZENDROP_ENDPOINT = process.env.ZENDROP_MCP_URL || "https://app.zendrop.com/mcp/v1";
/**
 * Default per call ceiling. Catalogue listings for the big categories are the
 * slow ones: Apparel has 110k products and took longer than 30s, so callers
 * that page a large category pass their own, longer timeout.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

export class ZendropError extends Error {
    constructor(message: string, readonly code?: number, readonly retryAfter?: string | null) {
        super(message);
        this.name = "ZendropError";
    }
}

/** Thrown when the integration is not configured, so callers can answer 503 rather than 500. */
export class ZendropNotConfiguredError extends ZendropError {
    constructor() {
        super("Zendrop is not configured");
        this.name = "ZendropNotConfiguredError";
    }
}

export function zendropConfigured(): boolean {
    return Boolean(process.env.ZENDROP_API_ACCESS_TOKEN);
}

let requestId = 0;

/** Zendrop rate limits a sustained sync, so a 429 is retried rather than lost. */
const MAX_RETRIES = 4;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Retry-After when the server sends one, otherwise exponential backoff. */
function backoffMs(attempt: number, retryAfter: string | null): number {
    const header = Number(retryAfter);
    if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 60_000);
    return Math.min(1000 * 2 ** attempt, 30_000);
}

/**
 * Call one Zendrop MCP tool and return its decoded payload.
 *
 * MCP wraps results as `content: [{type:"text", text:"<json>"}]`, so the JSON
 * is parsed out of that envelope and handed back as a plain object.
 */
export async function callZendropTool<T = any>(tool: string, args: Record<string, any> = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    const token = process.env.ZENDROP_API_ACCESS_TOKEN;
    if (!token) throw new ZendropNotConfiguredError();

    for (let attempt = 0; ; attempt++) {
        try {
            return await attemptCall<T>(token, tool, args, timeoutMs);
        } catch (e) {
            const rateLimited = e instanceof ZendropError && e.code === 429;
            if (!rateLimited || attempt >= MAX_RETRIES) throw e;
            const wait = backoffMs(attempt, (e as ZendropError).retryAfter ?? null);
            log.warn("Zendrop rate limited, backing off", { tool, attempt: attempt + 1, waitMs: wait });
            await sleep(wait);
        }
    }
}

async function attemptCall<T>(token: string, tool: string, args: Record<string, any>, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
        res = await fetch(ZENDROP_ENDPOINT, {
            method: "POST",
            signal: controller.signal,
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
                Accept: "application/json, text/event-stream",
            },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: ++requestId,
                method: "tools/call",
                params: { name: tool, arguments: args },
            }),
        });
    } catch (e) {
        const reason = (e as Error).name === "AbortError" ? `timed out after ${timeoutMs}ms` : (e as Error).message;
        log.warn("Zendrop request failed", { tool, reason });
        throw new ZendropError(`Zendrop request ${reason}`);
    } finally {
        clearTimeout(timer);
    }

    const raw = await res.text();
    if (!res.ok) {
        log.warn("Zendrop returned an error status", { tool, status: res.status });
        throw new ZendropError(`Zendrop responded ${res.status}`, res.status, res.headers.get("retry-after"));
    }

    let envelope: any;
    try {
        envelope = JSON.parse(raw);
    } catch {
        throw new ZendropError("Zendrop returned a non-JSON response");
    }

    if (envelope.error) {
        log.warn("Zendrop tool error", { tool, code: envelope.error.code, message: envelope.error.message });
        throw new ZendropError(envelope.error.message || "Zendrop tool error", envelope.error.code);
    }

    const content = envelope.result?.content;
    if (Array.isArray(content)) {
        const text = content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("");
        if (text) {
            try {
                return JSON.parse(text) as T;
            } catch {
                return text as unknown as T;
            }
        }
    }
    return envelope.result as T;
}
