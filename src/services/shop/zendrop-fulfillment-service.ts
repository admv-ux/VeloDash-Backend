import { AppDataSource } from "../../db/data-source";
import { ShopOrder, ShopFulfillmentStatus, ShopOrderStatus } from "../../models/shop-order";
import { callZendropTool, zendropConfigured } from "./zendrop-client";
import { STORE_ID } from "./store-sync-service";
import { ShopifyOrderService, shopifyConfigured } from "./shopify-order-service";
import logger from "../../utils/logger";

const log = logger.child({ service: "ZendropFulfillment" });

/**
 * Moving a paid order from "money taken" to "parcel moving".
 *
 * Zendrop's fulfil call SPENDS REAL MONEY, so nothing here charges without
 * being asked to. `fulfill_order` is a deliberate two step handshake: a
 * preview that costs nothing, then a confirmation valid for five minutes. Both
 * steps are made here back to back only when a caller passed confirm, and the
 * same is_credit_redeem value has to be used twice or Zendrop rejects it.
 *
 * One sharp edge in their API shapes this whole file: `fulfill_order` with
 * only a store_id and no order_ids targets EVERY unfulfilled order in the
 * store. An explicit order_ids is therefore always sent, never omitted.
 */

/** Zendrop's own status labels, mapped onto ours. */
const STATUS_MAP: Record<string, ShopFulfillmentStatus> = {
    Unfulfilled: ShopFulfillmentStatus.PUSHED_TO_STORE,
    Processing: ShopFulfillmentStatus.FULFILLING,
    Shipped: ShopFulfillmentStatus.SHIPPED,
    Delivered: ShopFulfillmentStatus.DELIVERED,
    Canceled: ShopFulfillmentStatus.FAILED,
    External: ShopFulfillmentStatus.PUSHED_TO_STORE,
};

export class FulfillmentError extends Error {
    constructor(message: string, readonly statusCode = 409) {
        super(message);
        this.name = "FulfillmentError";
    }
}

export interface CostPreview {
    orderIds: number[];
    total: number;
    currency: string;
    usingCredits: boolean;
    raw: any;
}

export class ZendropFulfillmentService {
    private orderRepo = AppDataSource.getRepository(ShopOrder);
    private shopify = new ShopifyOrderService();

    /** Normalise an order number for comparison: "#1004" and "1004" are one order. */
    static sameOrderNumber(a: unknown, b: unknown): boolean {
        const clean = (v: unknown) => String(v ?? "").trim().replace(/^#/, "").toLowerCase();
        const x = clean(a);
        return x !== "" && x === clean(b);
    }

    static mapStatus(zendropStatus: unknown): ShopFulfillmentStatus | null {
        return STATUS_MAP[String(zendropStatus || "").trim()] ?? null;
    }

    /**
     * Pull the tracking numbers out of an order's line items.
     *
     * Zendrop reports tracking per line, so a split shipment gives several
     * numbers for one order and the same number repeats across lines that
     * travelled together. Deduped, because showing a customer the same
     * tracking number four times reads as four parcels.
     */
    static extractTracking(zOrder: any): { number: string; carrier: string | null; url: string | null }[] {
        const seen = new Map<string, { number: string; carrier: string | null; url: string | null }>();
        for (const li of zOrder?.line_items || []) {
            for (const t of li.tracking || (li.tracking_number ? [li] : [])) {
                const num = String(t.tracking_number || t.number || "").trim();
                if (!num || seen.has(num)) continue;
                seen.set(num, {
                    number: num,
                    carrier: t.carrier || t.tracking_company || null,
                    url: t.tracking_url || t.url || null,
                });
            }
        }
        return [...seen.values()];
    }

    /** Step 1 of the money path: create the order in the store Zendrop reads. */
    async pushToStore(orderId: string): Promise<ShopOrder> {
        const order = await this.load(orderId);
        if (order.status !== ShopOrderStatus.PAID) {
            throw new FulfillmentError("Only a paid order can be pushed to the store");
        }
        if (order.shopifyOrderId) return order;
        if (!shopifyConfigured()) {
            throw new FulfillmentError("Shopify Admin API is not configured", 503);
        }

        try {
            const ref = await this.shopify.createOrder(order);
            order.shopifyOrderId = ref.id;
            order.shopifyOrderName = ref.name;
            order.fulfillmentStatus = ShopFulfillmentStatus.PUSHED_TO_STORE;
            order.fulfillmentError = null;
            return await this.orderRepo.save(order);
        } catch (e) {
            order.fulfillmentStatus = ShopFulfillmentStatus.FAILED;
            order.fulfillmentError = (e as Error).message.slice(0, 500);
            await this.orderRepo.save(order);
            throw e;
        }
    }

    /**
     * Find the order Zendrop ingested from Shopify and remember its id.
     *
     * Ingestion is not instant, so a miss here is normal rather than an
     * error: the caller retries later.
     */
    async linkZendropOrder(orderId: string): Promise<ShopOrder> {
        const order = await this.load(orderId);
        if (order.zendropOrderId) return order;
        if (!order.shopifyOrderName) {
            throw new FulfillmentError("Order has not been pushed to the store yet");
        }
        this.requireZendrop();

        const res = await callZendropTool<{ orders: any[] }>("get_orders", {
            store_id: STORE_ID,
            keyword: order.shopifyOrderName.replace(/^#/, ""),
            limit: 50,
        });
        const match = (res?.orders || []).find((o) =>
            ZendropFulfillmentService.sameOrderNumber(o.order_number ?? o.number ?? o.name, order.shopifyOrderName));
        if (!match?.id) {
            log.info("Zendrop has not ingested the order yet", {
                orderNumber: order.orderNumber, shopifyOrderName: order.shopifyOrderName,
            });
            return order;
        }

        order.zendropOrderId = Number(match.id);
        order.zendropStatus = match.status ? String(match.status).slice(0, 32) : null;
        const mapped = ZendropFulfillmentService.mapStatus(match.status);
        if (mapped) order.fulfillmentStatus = mapped;
        return await this.orderRepo.save(order);
    }

    /** What fulfilling would cost. Free to call and charges nothing. */
    async previewCost(orderId: string, useCredits = false): Promise<CostPreview> {
        const order = await this.load(orderId);
        const zid = this.requireZendropOrder(order);
        const raw = await callZendropTool<any>("get_order_fulfillment_cost", {
            store_id: STORE_ID,
            order_ids: [zid],
            is_credit_redeem: useCredits,
        });
        return {
            orderIds: [zid],
            total: Number(raw?.total ?? raw?.total_cost ?? raw?.amount ?? 0),
            currency: String(raw?.currency || "USD"),
            usingCredits: useCredits,
            raw,
        };
    }

    /**
     * Fulfil one order, spending money.
     *
     * The preview is always fetched first, even when confirming, because
     * Zendrop requires the confirmation to follow a preview with identical
     * inputs. `confirm: false` returns that preview and stops.
     */
    async fulfill(orderId: string, opts: { confirm: boolean; useCredits?: boolean }): Promise<{
        preview: CostPreview;
        dispatched: boolean;
        operationId: string | null;
        order: ShopOrder;
    }> {
        const useCredits = Boolean(opts.useCredits);
        let order = await this.load(orderId);
        const zid = this.requireZendropOrder(order);
        if (order.status !== ShopOrderStatus.PAID) {
            throw new FulfillmentError("Refusing to fulfil an order that is not paid");
        }
        if (order.fulfilledAt) {
            throw new FulfillmentError("This order has already been fulfilled");
        }

        const preview = await this.previewCost(orderId, useCredits);
        if (!opts.confirm) {
            return { preview, dispatched: false, operationId: null, order };
        }

        const res = await callZendropTool<any>("fulfill_order", {
            store_id: STORE_ID,
            order_ids: [zid],
            confirmed: true,
            is_credit_redeem: useCredits,
        });

        order = await this.load(orderId);
        order.fulfillmentStatus = ShopFulfillmentStatus.FULFILLING;
        order.fulfilledAt = new Date();
        order.fulfillmentCost = preview.total || null;
        order.fulfillmentError = null;
        order = await this.orderRepo.save(order);

        const operationId = res?.operation_id ? String(res.operation_id) : null;
        log.info("Dispatched fulfilment", {
            orderNumber: order.orderNumber, zendropOrderId: zid, cost: preview.total, operationId,
        });
        return { preview, dispatched: true, operationId, order };
    }

    /** Poll an async fulfilment operation. */
    async operationStatus(operationId: string): Promise<any> {
        this.requireZendrop();
        return callZendropTool<any>("get_order_fulfillment_operation", { operation_id: operationId });
    }

    /** Re-read the order from Zendrop and store status, cost and tracking. */
    async refresh(orderId: string): Promise<ShopOrder> {
        let order = await this.load(orderId);
        const zid = this.requireZendropOrder(order);
        const z = await callZendropTool<any>("get_order", { store_id: STORE_ID, order_id: zid });

        order.zendropStatus = z?.status ? String(z.status).slice(0, 32) : order.zendropStatus;
        const mapped = ZendropFulfillmentService.mapStatus(z?.status);
        if (mapped) order.fulfillmentStatus = mapped;
        const tracking = ZendropFulfillmentService.extractTracking(z);
        if (tracking.length) order.tracking = tracking;
        const cost = Number(z?.total_cost ?? z?.fulfillment_cost ?? NaN);
        if (Number.isFinite(cost) && cost > 0) order.fulfillmentCost = cost;

        order = await this.orderRepo.save(order);
        return order;
    }

    /** Carrier scan history for one tracking number. */
    async trackingEvents(trackingNumber: string): Promise<any> {
        this.requireZendrop();
        return callZendropTool<any>("get_tracking_events", { tracking_number: trackingNumber });
    }

    /** Zendrop credit balance, which fulfilment draws on when credits are used. */
    async creditBalance(): Promise<any> {
        this.requireZendrop();
        return callZendropTool<any>("get_billing_credit_balance", {});
    }

    private async load(orderId: string): Promise<ShopOrder> {
        if (!/^[0-9a-f-]{36}$/i.test(orderId)) throw new FulfillmentError("Unknown order", 404);
        const order = await this.orderRepo.findOne({ where: { id: orderId } });
        if (!order) throw new FulfillmentError("Unknown order", 404);
        return order;
    }

    private requireZendrop(): void {
        if (!zendropConfigured()) throw new FulfillmentError("Zendrop is not configured", 503);
    }

    private requireZendropOrder(order: ShopOrder): number {
        this.requireZendrop();
        if (!order.zendropOrderId) {
            throw new FulfillmentError("Zendrop has not picked this order up from the store yet");
        }
        return order.zendropOrderId;
    }
}
