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


## 2026-11-20 (later): checkout is live, the import is blocked

### The product import could not run: the Zendrop token is read only

The owner approved importing all 148 catalogue products into the connected
Shopify store. The first call refused:

```
add_my_product        -> Insufficient scope: 'my_products:write' required.
import_my_product     -> Insufficient scope: 'my_products:write' required.
update_store_settings -> Insufficient scope: 'stores:write' required.
fulfill_order         -> Insufficient scope: 'orders:write' required.
```

Every read tool works, so the catalogue sync and all the reporting above
are unaffected. But the token cannot write, which blocks **both** remaining
fulfillment steps, not just the import. A token with `my_products:write`
and `orders:write` is needed. Since the token has to be rotated anyway
(it was shared in plain chat), both can be done in one go.

### Checkout: guest basket to paid order

Stripe **hosted Checkout**, not Elements. Stripe collects the card and the
shipping address on their own page, so the shop never touches card data,
needs no publishable key and ships no payment JS. That also sidestepped a
trap: the cluster's `STRIPE_PUBLISHABLE_KEY` is a `pk_test_` while the
secret is `sk_live_`. Nothing uses it (the app carries its own key), but an
Elements build would have picked it up and failed in production.

New: `shop_orders`, `ShopCheckoutService`, `POST /shop/checkout`,
`GET /shop/orders/:id`, `GET /shop/shipping-countries`, and
`checkout.session.*` branches on the existing Stripe webhook.

**Instant dispatch cannot happen, by construction.** `shop_orders` is its
own table with no relation to the delivery `orders` table and no reference
from any dispatch code. Supplier stock ships on a multi day estimate, so a
shop order must never reach a courier queue. There is no field here a
dispatcher could read, and nothing creates a delivery Order from one.

### US only at launch, and that is a pricing limit not a shipping one

Retail prices were built from Zendrop's **US** shipping quote. Measured on
product 3217463 (wholesale 0.30, US shipping 4.16, landed 4.46, retail
9.99):

```
US 4.16    GB 3.37    GH 10.61    NG 10.61
```

Ghana costs 6.45 more per item. Against the live catalogue that puts 4 of
148 products underwater, averaging 0.57 below cost, and it thins the margin
on everything else. Checkout therefore accepts US addresses only, read from
`platform_settings.shopAllowedCountries`, so widening the list is a settings
change rather than a deploy once per destination shipping is priced at sync
time. Note GB is already *cheaper* than the US on this sample, so it is
likely safe to add after a wider check.

The storefront reads that same list, so the home page says where it ships
instead of claiming "worldwide".

### Verified in production, without charging a card

- a real live Stripe session: total 1230.97 matched the basket exactly, and
  the hosted page rendered the right line items, images, per unit prices,
  prefilled email, VELO branding and a country field locked to the US
- price tampering: posting `price: 0.01` for a 586.99 product produced an
  order of **586.99**. The client sends ids and quantities; the server
  prices everything
- rejected, each with the right status: empty basket, missing items key,
  quantity 0 / -5 / 1.5 / 999, duplicate lines summing past the cap, a SQL
  shaped id, an unknown uuid. None of them created an order row
- the rate limiter fired during testing and the storefront surfaced it
  rather than silently failing
- webhook, signed with the real secret from inside the pod: a valid event
  marked the order paid, stamped the payment intent and stored the address;
  a **replay changed nothing** (one "Shop order paid" line for two
  deliveries); a **bad signature was rejected**; an event claiming 1.00
  against a 586.99 order was **refused** with "Paid amount is below the
  order total"

### Browser verification of the buying flow

26 checks against the live site at 1440px and 390px, all passing: empty
basket, adding from the shop, the badge count, two basket lines, delivery
shown as included, the shipping line, quantity edits recalculating, the
handoff landing on Stripe with the same total and the email carried over,
the country locked to the US, cancel returning to a full basket, the
confirmation page (order number, total, address, and the wording that this
is not a same day delivery), the basket clearing after payment, an unknown
order id handled, and no horizontal overflow or console errors.

Two things that looked like bugs and were not: Stripe renders its form in a
cross-origin iframe, so assertions had to read every frame and input
values, not just the top document; and the only console error came from
`api.hcaptcha.com` returning 429 on Stripe's own page, after repeated
testing from one address. Our own origin served zero 4xx.

The storefront suite from earlier was re-run after the shipping copy change:
55/55 still passing.

### Cleanup

Verification created 7 orders and 7 live Stripe sessions. All 7 orders were
deleted (scoped by the synthetic payment intent and the verification email
addresses, never a blanket delete) and all 7 sessions explicitly expired.
`shop_orders` is back to 0 rows and 0 revenue, so the first row in there
will be a real customer.

### Admin

`/shop` in the dashboard: Orders (paid revenue, awaiting payment, awaiting
fulfilment, and a fulfilment control), Catalogue (landed cost, multiplier,
retail, margin) and Merchant applications. `PATCH /admin/shop/orders/:id`
deliberately cannot set `status`: whether the money arrived is Stripe's
answer, not an admin's.

Endpoints are live and correctly gated (403 unauthenticated). Rendering the
page with real data was not verified from here: it needs an admin login,
and reading a real admin's phone number to impersonate them was out of
bounds. Worth a look next time you are signed in.

### Still needs the owner

1. **A Zendrop token with write scopes** (`my_products:write`,
   `orders:write`), which also rotates the leaked one.
2. **The Shopify Admin API token** (`shpat_...`), still outstanding.
3. `ZENDROP_API_ACCESS_TOKEN` as a GitHub repo secret.
4. The `www.shopvelodash.com` A record, if `www` should resolve.
