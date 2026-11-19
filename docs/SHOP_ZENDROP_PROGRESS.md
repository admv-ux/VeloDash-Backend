# VeloDash Shop + Zendrop: build log

Started 2026-11-19. Vertical slices, each one shippable and tested before the
next begins.

## Verified facts about Zendrop (established 2026-11-19, not assumed)

The integration guidance supplied by Zendrop support was wrong. There is no
REST endpoint taking `{"action": "get_catalog_product"}`. `app.zendrop.com/mcp/v1`
is an **MCP JSON-RPC 2.0** server and rejects anything else:

    {"error":{"code":-32600,"message":"Invalid Request: Invalid JSON-RPC version. Must be \"2.0\"."}}

A correct `initialize` returns `serverInfo: {"name":"Zendrop Server","version":"0.0.1"}`,
protocol `2025-11-25`. `tools/list` returns **38 tools**.

Confirmed live with the account token:

| Probe | Result |
|---|---|
| `get_catalog_products` | 1,147,595 products |
| filters available | `keyword`, `category_id`, `min_price`, `max_price`, `ships_from`, `supplier_id`, `page`, `limit` |
| `get_catalog_categories` | full tree with `parent_id` and `visible_product_count` |
| `get_catalog_shipping_estimate` 2693395 US | $13.68, 8 days |
| `get_catalog_shipping_estimate` 2693395 GH | $19.18, no ETA |
| product 2693395 wholesale | $7.99 |
| `get_stores` | **0 stores** |

### Measured latency, which decides the architecture

| Call | Time |
|---|---|
| `get_catalog_products` limit 12 | 4.9s to 7.0s |
| `get_catalog_products` limit 50 | 5.2s |
| `get_catalog_products` limit 100 | 5.9s, and only 60 come back |
| `get_catalog_products` filtered by category and price | 11.0s |
| `get_catalog_shipping_estimate`, one | 0.9s |
| twelve estimates in parallel | 2.1s |

A storefront cannot call this on page load. The catalogue is therefore **synced
into our own Postgres** and the shop reads only local rows.

That also fixes a semantics problem: Zendrop's `min_price`/`max_price` filter the
**wholesale** price, while a shopper filters the **retail** price. Retail is
computed at sync time and stored, so the filter means what the customer thinks
it means.

Two more quirks worth recording:

- the server rejects a JSON-RPC `id` that is not an integer, with -32600
  "The [id] member must be a string, number"
- **Zendrop enforces a sustained quota, not just a burst limit.** Six rapid calls
  pass fine, but syncing seven categories back to back got every subsequent call
  429'd for minutes, and no short backoff recovers from that. The catalogue is
  therefore filled by a paced background job taking ONE category page per tick,
  15 minutes apart, off unless `SHOP_SYNC_ENABLED=true`.

### Two consequences

1. **Fulfillment is blocked.** `fulfill_order`, `get_orders`, `update_store_settings`
   and `add_my_product` all require `store_id`, and the account has no store. The
   fulfillment path is written against the real tool schemas but stays
   **unverified** until a store exists.
2. **Nothing from Zendrop can be delivered instantly.** Stock ships from CN on an
   8 day US estimate. Shopping orders must never enter driver dispatch, which is
   requirement 3.

## Decisions taken by the owner

- Payments: **Stripe everywhere, Paystack retired.** Note this needs real Stripe
  card charging, because `getGatewayProvider()` currently returns Paystack with
  the comment that "Stripe has no initiateCardPayment".
- Fulfillment: build now, verify once a store is connected.
- Pricing: always round **up to .99**.

## Pricing rule

    cost      = wholesale + US shipping
    multiplier = 2.2 if cost < 15
                 1.8 if 15 <= cost <= 35
                 1.5 if cost > 35
    retail    = roundUpTo99(cost * multiplier)

VeloDash takes no 15% delivery commission on shopping orders; the margin is the
multiplier.

## Slices

| # | Slice | State |
|---|---|---|
| 1 | Zendrop MCP client + pricing engine | **done**, 14 pricing tests + 7 sync tests |
| 2 | Catalog API (list, filter, detail, categories) | **done**, public, no auth |
| 3 | Storefront: browse, filter, product, basket, merchant application | **built and serving on the VPS**, awaiting DNS |
| 4 | Cart, checkout, Stripe payment | basket done; checkout **not started** |
| 5 | Order push to Zendrop fulfillment | pending |
| 6 | Block instant dispatch for shopping orders | pending |
| 7 | Drop the 15% on shopping deliveries | **done by construction**: shopping never enters the commission path, the multiplier is the margin |
| 8 | Retire Paystack | pending |
| 9 | Admin view + CRUD | backend **done**, admin UI pending |

## Live as of 2026-11-19

Verified against production, not asserted:

    GET /api/v1/shop/products      -> 148 products, no auth, no API key
    GET /api/v1/shop/categories    -> Animals & Pet Supplies 50, Apparel 48,
                                      Handbag & Wallet Accessories 50
    GET /api/v1/shop/price-range   -> 9.99 to 74.99
    price filter 20 to 40, asc     -> 16 matches, correctly ordered
    all 60 sampled prices end .99  -> 0 violations

### A deploy bug found on the way

Every backend deploy since the repo moved to the **admv-ux** GitHub org had been
shipping nothing while reporting success. `IMAGE_NAME` is
`${{ github.repository_owner }}/velo-backend`, so the build started pushing to
`ghcr.io/admv-ux/velo-backend` while the manifest still said
`ghcr.io/velocouriersvc/velo-backend`, and the deploy only ran `rollout restart`.
Caught because `dist/` in the running pod had no shop files. The deploy now runs
`kubectl set image` from the same path the build pushed to, so the manifest and
the registry cannot drift apart again.


## What is live, and what is not

**Live and verified in production**

- `GET /api/v1/shop/*`, public, no auth: 148 products across 3 categories
- pricing: every stored price ends in .99 and sits above landed cost
- retail price filtering, category filter, sort, paging
- merchant application endpoint with its own 5/hour rate limit
- storefront served by nginx on the VPS and reachable by Host header
- CORS now admits shopvelodash.com; it did not, and the shop would have
  launched dead in a browser

**Built but not yet verifiable**

- the paced catalogue sync. Logic is unit tested and it is OFF
  (`SHOP_SYNC_ENABLED`), because Zendrop's quota was exhausted while
  loading the launch catalogue and it needs a quiet period to observe.

**Not started**

- checkout and Stripe payment. The basket works and the Checkout button is
  deliberately disabled rather than pretending to take money.
- pushing orders to Zendrop. Blocked: `get_stores` returns zero, so no
  fulfillment tool can be called at all.
- blocking instant dispatch for shopping orders.
- retiring Paystack. This one is a live payments migration and needs
  `initiateCardPayment` implemented on Stripe first.
- admin UI for the shop tables. The backend endpoints exist.

**Needs the owner**

- point `shopvelodash.com` A record at 162.35.106.11, then certbot for HTTPS
- connect a store in Zendrop so fulfillment can be built and tested
- add `ZENDROP_API_ACCESS_TOKEN` as a GitHub repo secret. It is set in the
  cluster already; without the repo secret the deploy simply leaves the
  cluster value alone, so nothing breaks, but it is not reproducible.
- **rotate the Zendrop token.** It was shared in plain chat.
