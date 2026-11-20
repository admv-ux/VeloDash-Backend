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


## 2026-11-20: HTTPS, the storefront rebuild, and the fulfillment path

### Domain and TLS, done

`shopvelodash.com` A record now points at 162.35.106.11. Certificate
issued for the apex and nginx redirects http to https:

```
http://shopvelodash.com   301 -> https://shopvelodash.com
https://shopvelodash.com  200
expires 2027-02-18, auto renewal scheduled
```

`www.shopvelodash.com` has **no DNS record**, so it was left off the
certificate deliberately: including an unresolvable name fails the whole
request. Add the `www` A record and the cert can be expanded.

### Storefront home rebuilt as a shopping landing page

`/` is now a landing page and browsing moved to `/browse`. Old links that
carried filters on `/` redirect to `/browse` with their query intact, so
nothing already shared breaks.

New: rotating hero, category tiles built from real product images,
horizontal product rails, add to basket from a card, recently viewed in
localStorage, mobile bottom navigation and a filter drawer.

Rails lower down skip products a rail above already showed. Without this,
"New arrivals" and the Apparel rail rendered almost the same items,
because the newest stock in a 148 product catalogue is all one category.
Measured after the fix: 81 distinct products on the landing page, 10 of
them appearing in more than one rail.

Verified with 55 browser checks at 1440px and 390px, run twice: against
the built bundle served under the production origin, and again against
the live site after deploy. Both runs 55/55. Checks cover hero controls,
rail scroll state, quick add and the basket badge, category and price
filters, search result correctness, the legacy redirect, product detail,
the more-in-category rail excluding the product being viewed, recently
viewed, basket, merchant form, 404, console errors, failed requests and
horizontal overflow. Separately: all 84 images on the landing page load,
zero broken.

### The Zendrop store is connected, and the fulfillment path is now known

`get_stores` returns a store, so the earlier hard block is cleared:

```
id 3941837, "My Store", hgrv28-fx.myshopify.com, shopify, connection_status 1
auto_fulfillment_enabled: false
plan: Plus Monthly, 79 USD, active.  credit balance: 59 (promotional)
```

**There is no `create_order` tool.** All 38 MCP tools were enumerated.
Zendrop can only *fulfill* orders it already holds, and it only holds
orders that arrived from a connected store. So the Shopify bridge is
mandatory, not a shortcut: Stripe payment in VeloDash, then a silent
order POST to Shopify Admin API, then Zendrop ingests it, then
`fulfill_order`.

**A gap the Zendrop advice did not mention.** Posting an order to Shopify
is not sufficient on its own. `fulfill_order` works on line items it can
map back to catalogue products, which means each product must first be
pushed into the store with `add_my_product` then `import_my_product`.
Checked against the live data:

```
active catalogue rows                  148
of those, already in the shopify store   0
```

The store holds 34 products, all `in_store`, and **not one of them is a
product this shop sells**. So the chain is:

1. `add_my_product(product_id, store_id)` for each product we list
2. `import_my_product(import_list_id)`, async, poll
   `get_my_product_import_operation`
3. record the resulting Shopify variant id on our `shop_products` row
4. on a paid Stripe order, POST to Shopify Admin API with those variants
5. Zendrop ingests the order, it shows in `get_orders`
6. `fulfill_order` with `confirmed=false` to preview cost, then
   `confirmed=true` within 5 minutes to dispatch

This also bounds the catalogue: we can only list what we have imported,
and importing is rate limited the same way the catalogue sync is.

### Still needs the owner

- the Shopify Admin API token (`shpat_...`) and the store domain. Settings
  then Apps and sales channels then Develop apps.
- a decision on importing our 148 products into the Shopify store. That
  writes to their real store, so it was not done unprompted.
- add the `www.shopvelodash.com` A record if `www` should work.
- `ZENDROP_API_ACCESS_TOKEN` as a GitHub repo secret.
- **rotate the Zendrop token.** It was shared in plain chat.
