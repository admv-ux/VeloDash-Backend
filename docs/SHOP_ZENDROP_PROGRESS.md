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

---

## 2026-11-22: the store, not the catalogue, decides what we sell

### The 148 was never a Zendrop limit

The question was whether Zendrop had only given us 148 products. They had
not. Measured against the live tables:

| | |
|---|---|
| Zendrop categories mirrored | 230 |
| Products visible across them | **1,297,745** |
| Categories we had ever pulled from | 3 |
| Products we held | 148 |

The ceiling was ours. `shop-catalog-sync.ts` takes **one page of 50 from one
category per 15 minute tick**, only for categories holding 500+ products,
and `syncCategoryPage` marks a category carried as soon as its first page
saves. So each category contributes 50 products once and is never revisited:
67 eligible categories put a hard ceiling of ~3,350 on the whole shop, and
the job is off by default anyway. The 148 is 50 + 50 + 48, three categories,
two products dropped for having no shipping quote.

Separately, the Shopify Storefront pagination theory does not apply: the
store answers in a single page and `hasNextPage` is false. The sync written
here pages properly regardless, but there was nothing past page one.

### The thing that actually mattered: zero overlap

The 148 products on the site and the 119 in the Shopify store were
**completely disjoint sets**. Not partially; the intersection was empty.

That is worse than it sounds. Zendrop has no `create_order` and only fulfils
orders arriving from a connected store, matching line items back to store
products. So every one of the 148 products the shop was selling was
unshippable, and the ~125 that could be shipped were not on the site.

So the model is inverted: **the store is the source of truth for what we
offer**, and the catalogue is consulted only for the one thing the store
cannot tell us, which is what the item costs us.

### StoreSyncService

`src/services/shop/store-sync-service.ts`. Per product:

1. `get_my_products` (paged, 60 max per page) for the import list.
2. `get_my_product` for the Shopify product id and the variant map.
3. `get_catalog_product` for wholesale cost and the catalogue variants.
4. `get_catalog_shipping_estimate` (US) for the landed cost.
5. Our own markup via `retailPriceFor`, per variant.

`isFulfillable` is set only when the product is in the store, `store_sync_status`
is `synced`, a US shipping quote exists and at least one variant survives
pricing. Every catalogue read is gated on it, so the shop cannot list what it
cannot ship. A full pass also delists anything that has left the store; a
partial pass may not, because it has not seen the products it did not reach.

**All read-only tools.** This does not need `my_products:write`, which is why
it could be built and run while that scope is still missing.

#### Rate limiting is sustained, not burst

Six concurrent calls got 95 of 125 products served a Cloudflare 429
challenge, and the block persisted for minutes afterwards. The service runs
strictly serially with a 1.2s gap. A full pass over ~125 products is about
three hundred upstream calls and takes roughly ten minutes. That is the
correct trade, not a bug.

### Variants

87 of the 119 store products have options, up to 20 of them. The old model
had one price per product and no variant concept at all, so an order would
have named a product and let the supplier pick a size.

- `ShopProduct.variants` holds the Shopify variant id, SKU, title, wholesale,
  landed cost and retail per variant.
- Store and catalogue variants are joined **on SKU**, the one field both
  carry from the same supplier record. A missing or duplicated SKU falls back
  to position; a variant that cannot be priced is dropped, not guessed.
- Order lines carry `variantId`, which is what fulfilment actually needs.
- A product with options is **refused** at checkout if no variant was chosen.
  Shipping the wrong size is a refund, a return and a lost customer.
- The listed price is the cheapest variant, so the grid never undercuts the
  detail page.

#### The $52,257.76 sweater

Zendrop pushed a variant of "Vintage Men's Color Block Knit Sweater" to the
store at $52,257.76. Marked up it would have been a five figure listing one
accidental purchase away from a real loss. Variants above a $2,000 sanity
ceiling are dropped and the rest of the product still sells.

### Shipping, customs and honest copy

The home page paired a globe icon and "Delivered to your door" with "We ship
to United States", which reads as a worldwide promise next to a checkout
that takes US addresses only.

Measured, not assumed: of a 30 product sample, **28 ship from China** (8 day
US estimate) and 2 from a US Amazon supplier (2 days). Zendrop returns an
empty `shipping_options` array for Ghana on US-supplier items, so for part of
the catalogue the answer is not "expensive", it is "no service".

The US ended duty-free de minimis treatment for Chinese goods on 2 May 2025
and for everywhere else on 29 August 2025, so low value parcels from abroad
can now attract duty. A new `/shipping` page states where we ship, where
stock ships from (counted live from `shipsFrom`, so it cannot drift), typical
times, and the duty position.

> **Policy written into the page, flag if you disagree:** the price at
> checkout is the whole price including any import charge, and if a carrier
> ever bills a customer duty we refund it. The alternative is a shopper
> getting an unexpected bill at the door, which costs more in trust than the
> duty costs in cash. Changing it means editing `src/pages/Shipping.jsx` and
> the Terms.

### velocouriersvc.com

Four legal documents were live at once with two different "last updated"
dates and two different sets of terms: `/legal/terms/` and `/privacy/` (April
25), `/terms.html` and `/privacy.html` (January 1). Which governed was
anyone's guess. `/legal/privacy` was a 404 and was linked from the live shop
footer; `/terms/` was a 404 too.

Done locally, **not deployed**: the site is on cPanel shared hosting at
66.29.148.143, not our VPS, and there are no credentials for it in the repo.

- `/legal/terms/` is now canonical Terms, dated today, with a new section 9
  covering sale of goods: who you buy from, not a courier delivery, price
  includes duty, where we deliver, delivery estimates, pricing errors,
  cancellations and returns, Stripe.
- `/privacy/` is canonical Privacy, keeping the `#terms` anchor the shipped
  mobile apps deep-link to. Adds Stripe, Shopify and Zendrop as named
  processors and is explicit that a shop order sends the delivery address
  abroad. The flat "three months after termination" retention claim was wrong
  for transaction records and now says so.
- `.htaccess` redirects the duplicates to the canonical pair and 503s the
  marketing site to `maintenance.html`, while leaving `/privacy`, `/legal`,
  `/support`, `/.well-known` and static assets reachable, because the store
  listings and the shop link straight at them.

The shop footer now points at `/privacy/` and `/legal/terms/`, which exist.

### Still needs the owner

1. **cPanel or FTP access for velocouriersvc.com**, or upload the prepared
   files yourself. Nothing in that folder is deployed.
2. **A Zendrop token with write scopes** (`orders:write` for `fulfill_order`),
   which also rotates the leaked one. `my_products:write` is no longer needed
   for the catalogue, only for pushing new products from our side.
3. **The Shopify Admin API token** (`shpat_...`), to post paid orders into the
   store so Zendrop ingests them.
4. `ZENDROP_API_ACCESS_TOKEN` as a GitHub repo secret.
5. The `www.shopvelodash.com` A record, if `www` should resolve.

### Two bugs the first live run exposed

Both were found by measuring production rather than by reading the code, and
neither would have shown up in a unit test.

**1. Products arrived with no category.** `syncOne` never read
`get_catalog_product.categories`, so `/shop/categories` returned an empty
list and the category tiles, the browse filter and the "more in this
category" rail all silently emptied. 28 of 30 sampled products do carry a
Zendrop category. The sync now records it and creates the `shop_categories`
row if the tree job has not seen it, since the storefront only offers
categories flagged `isCarried`.

**2. The advisory lock held nothing.** `pg_locks` showed no advisory lock
while a pass was plainly running, and throughput measured **20 products a
minute against a hard ceiling of 16.6 for one process**, so both replicas
were syncing at once and doubling the load on an upstream that rate limits
sustained traffic.

The cause: `AppDataSource.query()` takes a connection from the pool per
call, and an advisory lock belongs to the session that took it. Acquiring
and releasing through the pool means the unlock runs on a session that never
held the lock. Fixed with a dedicated `QueryRunner` released in a `finally`,
so both statements share one session and the session ends even if the pass
crashes between them.

Verified live after the fix: `pg_locks` shows `848201` granted, the second
replica logs "Store sync already running elsewhere, skipping this pass", and
throughput dropped to 14/min.

### Verification

| Suite | Result |
|---|---|
| Backend unit/integration | **260 passed, 26 suites** (was 228/25) |
| Variant + catalogue E2E, live site, desktop and 390px | **52 / 52** |
| Paid order with two options, real Stripe session + signed webhook | **20 / 20** |

The paid-order run proves the whole money path with variants: a live Stripe
session for two options of one watch, marked paid by a webhook signed
**inside the pod** so the signing secret never left the cluster, then the
order page rendered with both option names, the total and the delivery
address. No card was charged.

Afterwards all five verification orders were deleted and their five live
Stripe sessions expired. `shop_orders` holds **0 paid revenue**.

> One row remains that is **not** from this work: `VD-FCVDJLRG`,
> `payment_failed`, $9.99, created 2026-11-21 23:45 with no email. No money
> moved. It is left alone because it cannot be told apart from a real
> shopper whose card was declined. Delete it if you know it was a test.

### The store is still filling

The Zendrop import list grew from **125 to 227 entries** while this was being
built, so more products are being pushed to Shopify as this is written. The
sync picks them up on its own: nothing needs re-running by hand, and the
twice-daily pass will keep the shop level with the store.

### Third bug, from the first completed pass

`listed 226, synced 219, skipped 7` and every one of the 7 skips was the
same thing:

```
null value in column "wholesalePrice" of relation "shop_products"
violates not-null constraint
```

`wholesalePrice` is NOT NULL with no database default. The unshippable path
saves the row deliberately, so the admin can see a product Zendrop will not
ship to the US, but a brand new row reached that save with the column unset
and the insert threw. The rows were never recorded at all, so those seven
products disappeared rather than showing up as unsellable. New rows now
carry zeroes in the money columns before anything can save them.

Nothing was mispriced by this: the failure was on insert, so no bad row ever
reached the shop.

### Where this landed

| | before | after |
|---|---|---|
| Products on the shop | 148, **none shippable** | **219, all shippable** |
| Overlap with the Shopify store | **0** | complete |
| Categories | 3 | 44 |
| Price vs Zendrop's own | - | **~42% lower**, none below cost |
| Products with options handled | none | all, via Shopify variant ids |

### Who restricts the delivery countries (it is us)

The shipping page originally read "if you enter an address anywhere else,
Stripe will not let the order through", which is backwards and the owner
caught it. Stripe is a payment service provider and has no view on where we
deliver.

The mechanism is one line in `createCheckout`:

```ts
shipping_address_collection: { allowed_countries: countries as any },
```

`countries` is read from `platform_settings.shopAllowedCountries`. We hand
Stripe the list, their hosted page offers only those in the address
dropdown, and that is the whole enforcement. Collecting the delivery address
is ours to configure; Stripe just renders the form we asked for and takes
the money.

So widening the shop to another country is a settings change plus correct
prices, never a payment-provider limitation. The page now says so.

---

## 2026-11-22, later: worldwide delivery, priced per destination

The owner's direction: deliver globally, to countries with dependable
address systems.

### Measured first

27 candidates were quoted against six real products spanning the price range
and both suppliers. The result decided the design:

| | |
|---|---|
| Countries returning a quote for the main supplier | **27 of 27** |
| Countries returning a quote for US-supplier items | **1 of 27** (the US) |
| Destinations CHEAPER than the US | most of them |

Sample spreads that killed the idea of one international fee:

```
Graphite case      US 4.58    AU 12.39   PL 2.56    (+7.81 worst)
Leather jacket     US 44.77   GB 22.49   IL 71.99   (+27.22 worst)
Oxygen tank        US 115.10  SG 29.91   IL 172.26  (+57.16 worst)
```

A flat surcharge would have overcharged Europe on the jacket and
undercharged Israel by fifty seven dollars on the same day.

### How it works

`ShippingQuoteService` quotes per product per country. Retail prices already
carry US shipping, so only the **difference** is charged, and a destination
cheaper than the US costs the shopper nothing extra rather than earning an
invented surcharge. Quotes are cached on the product, including a definite
"ships nowhere there", because Zendrop takes half a second per call and rate
limits sustained traffic. An upstream failure is never cached: a 429 is not
an answer about where a supplier ships, and caching it would block a country
for a fortnight.

A basket containing something that cannot reach the destination is refused
with **every** blocked item named at once, because roughly one product in
fourteen here comes from a US-only supplier and discovering that one item per
attempt is miserable.

Stripe is sent `allowed_countries: [thatCountry]`, not the whole list, so a
shopper cannot pick a destination we did not price.

### Two bugs caught in verification

**The cart showed the previous country's total while re-quoting.** React
Query's `placeholderData` kept the old numbers on screen, so switching to
Australia briefly displayed the US total as though it were the Australian
one. It now shows "Checking" and greys the total until the new quote lands.

**`createCheckout` returned `subtotal` as `total`.** Identical while shipping
was always zero, wrong the moment a destination could add to it: the cart was
told $37.98 for a $51.14 charge. The stored order and the Stripe session were
both correct; only the response lied.

### Verified live

A real Australian session, read back from Stripe:

```
amount_total                5114
shipping_address_collection {"allowed_countries": ["AU"]}
line  "Mojiang Bear ... Peeler and Grater"   x2   3798
line  Shipping to Australia                  x1   1316
```

284 backend tests across 27 suites. 56/56 and 19/19 browser checks on the
live site, desktop and 390px, including a US-only item correctly blocking a
German destination and naming itself.

### Worth knowing

- `platform_settings` holds **10 rows** and `allowedCountries()` reads one via
  `findOne({ where: {} })`. All ten were set to the same list, so behaviour is
  correct today, but the duplication is pre-existing and should be reconciled.
- Two orders predate or sit outside these runs and were deliberately left:
  `VD-FCVDJLRG` (payment_failed, $9.99, 2026-11-21) and one at 22:53 on
  2026-11-22 for $61.99, both with no email and no money taken. They cannot be
  told apart from a real shopper who did not finish paying.

## Slice: the supplier fulfilment chain (2026-11-23)

A full-privilege Zendrop token arrived, so the write half of the API is open.
The token was installed in the cluster and verified end to end.

### The constraint that shapes everything

**Zendrop has no `create_order` tool.** `tools/list` returns 39 tools covering
fulfil, cancel, track, cost, issues, billing and stores, and nothing that
injects an order. Zendrop only ever learns about an order by reading it from
the connected store, so the money path has to be:

```
Stripe paid -> order written into Shopify -> Zendrop ingests -> fulfill_order
```

Each hop is a separate, resumable step, because when a parcel is missing the
question is never "did it fail" but "which hop did it fail at".

### Two sharp edges in the Zendrop API

**`fulfill_order` with a `store_id` and no `order_ids` targets EVERY
unfulfilled order in the store.** One careless call would charge the account
for the lot. An explicit `order_ids` is always sent, never omitted, and a test
asserts it by name.

**Fulfilment is a two step handshake.** A free preview, then `confirmed: true`
within five minutes carrying an *identical* `is_credit_redeem`; a mismatch is
rejected. The service always previews first, even when confirming, and returns
the cost without charging when `confirm` is false.

### What was built

| File | Does |
| --- | --- |
| `src/services/shop/shopify-order-service.ts` | Writes the paid order into Shopify |
| `src/services/shop/zendrop-fulfillment-service.ts` | Links, prices, fulfils, tracks |
| `AdminShopController` + `adminRoutes` | One endpoint per hop |
| `velo-admin` Orders table | Chain state plus one "next step" button |

`ShopOrder` gained `shopifyOrderName`, `zendropStatus`, `fulfillmentCost`,
`tracking` and `fulfilledAt`. `shopifyOrderName` ("#1004") exists because it is
the **only** handle Zendrop can be searched by: `get_orders`'s `keyword` filter
matches the store's order number, not our `VD-` code and not the Shopify
numeric id.

Shopify receipts are suppressed on the pushed order. The sale already happened
on shopvelodash.com through Stripe, and a second confirmation from an
unfamiliar myshopify.com address reads as a phishing attempt.
`inventory_behaviour: bypass` is deliberate too: these are dropshipped goods
with no stock of our own, and the default refuses an untracked variant.

### The token, and a security finding

The leaked token was still **fully live with identical privileges**, verified
with real authenticated calls against a deliberately invalid control. A new
token does not revoke an old one. Only the owner can delete it in the Zendrop
dashboard.

`tools/list` returns the same 39 tools for any valid token, so it is useless
for checking privileges. Use `get_stores` or `get_billing_credit_balance`.

The GitHub repo secret `ZENDROP_API_ACCESS_TOKEN` is **not set**, which is
safe: `set_secret` skips an empty repo secret and leaves the cluster value
alone. If it is ever set to a stale token it will overwrite the good cluster
value on the next deploy.

### Verified live

```
cluster + both pods see the new token        yes, and it survived a deploy
cold Korea quote through the live API         $23.99 + $5.50 = $29.49
compiled service in-pod -> Zendrop credit     $59
all six new routes in the shipped bundle      yes
live admin bundle carries the new UI          yes
sellable products / destinations              219 / 27, unchanged
```

333 backend tests across 28 suites, 49 of them new.

### Not done, and why

- **`SHOPIFY_ADMIN_TOKEN` (`shpat_...`, `write_orders`) does not exist yet.**
  Until it does, `pushToStore` answers 503 and the admin dashboard shows an
  amber banner saying orders cannot reach the supplier. Payments are still
  taken and recorded correctly.
- **No real fulfilment has been dispatched.** `confirmed: true` spends money
  and there is nothing in the store to fulfil, so the write path is proven by
  tests and by its free preview only.
- **No customer emails.** Neither an order confirmation nor a tracking mail
  exists; the buyer currently sees only the confirmation page and whatever
  Stripe sends.
