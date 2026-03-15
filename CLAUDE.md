# wiki-plugin-shoppe — Developer Documentation

Multi-tenant digital goods shoppe for Federated Wiki, powered by Sanora.

## Architecture

Follows the Service-Bundling Plugin Pattern. Each tenant (seller/creator) gets their own Sanora user account, identified by a UUID and an 8-emoji emojicode (same format as BDO: 3 base + 5 unique from the EMOJI_PALETTE).

### Tenant Identity

Each tenant has:
- **UUID** — their Sanora user UUID
- **Emojicode** — 8-emoji human-readable identifier (e.g. `🛍️🎨🎁🌟💎🐉📚🔥`)

The first 3 emoji are fixed per wiki instance (`SHOPPE_BASE_EMOJI`, default `🛍️🎨🎁`). The last 5 are unique per tenant.

### Tenant Lifecycle

1. Wiki owner registers a tenant: `POST /plugin/shoppe/register { name }`
   - Plugin creates a Sanora user + an Addie user for the tenant
   - Generates emojicode + owner keypair (secp256k1 via sessionless)
   - Stores `{ uuid, emojicode, name, keys, addieKeys, ownerPubKey }` in `~/.shoppe/tenants.json`
   - Owner private key is delivered once via a single-use starter bundle download (bundleToken)
2. Tenant runs `node shoppe-sign.js init` — moves private key to `~/.shoppe/keys/<uuid>.json`
3. Tenant runs `node shoppe-sign.js payouts` — completes Stripe Connect Express onboarding
4. Tenant builds their archive and runs `node shoppe-sign.js` to sign and zip
5. Tenant drags the zip onto the wiki plugin widget
6. Plugin verifies `uuid + emojicode + owner signature`, processes all goods into Sanora
7. Shoppe accessible at `/plugin/shoppe/:uuid` or `/plugin/shoppe/:emojicode`

### shoppe-sign.js commands

| Command | Description |
|---------|-------------|
| `node shoppe-sign.js init` | Move `shoppe-key.json` to `~/.shoppe/keys/<uuid>.json` (no npm needed) |
| `node shoppe-sign.js` | Sign manifest + create upload.zip |
| `node shoppe-sign.js orders [wiki-url]` | Generate signed orders URL (5-min expiry), open in browser |
| `node shoppe-sign.js payouts [wiki-url]` | Generate signed payouts URL, redirect to Stripe Connect onboarding |

## Archive Format

```
my-shoppe.zip
  manifest.json           ← required: { uuid, emojicode, name }
  books/
    My Novel/             ← subfolder per book
      my-novel.epub
      cover.jpg
      info.json           ← { "title": "…", "description": "…", "price": 0 }
    Technical Guide/
      guide.pdf
      cover.jpg
      info.json
  music/
    My Album/             ← album = subfolder
      cover.jpg
      01-track.mp3
      02-track.mp3
    Standalone Track.mp3  ← standalone track = file directly in music/
  posts/
    01-Hello World/       ← numeric prefix determines table of contents order
      post.md             ← the post content (required)
      cover.jpg           ← optional cover image
      screenshot.png      ← any assets referenced in the markdown
      info.json           ← optional: { "title": "…", "description": "…" }
    02-My Series/         ← subdirectories = multi-part series
      cover.jpg           ← optional series cover
      intro.md            ← optional series intro
      info.json           ← optional: { "title": "…", "description": "…" }
      01-Part One/
        post.md
        diagram.png
      02-Part Two/
        post.md
  albums/
    Vacation 2025/        ← photo album = subfolder
      photo1.jpg
      photo2.jpg
  products/
    01-T-Shirt/           ← numeric prefix sets display order
      hero.jpg            ← main product image (hero.jpg or hero.png)
      info.json
  appointments/
    Therapy Session/      ← subfolder per bookable service
      cover.jpg           ← optional cover image
      info.json           ← required (see format below)
  subscriptions/
    Bronze Tier/          ← subfolder per membership tier
      cover.jpg           ← optional cover image
      info.json           ← required (see format below)
      bonus-track.mp3     ← any other files become exclusive member content
      chapter-draft.pdf
```

### manifest.json

```json
{
  "uuid": "your-uuid-from-registration",
  "emojicode": "🛍️🎨🎁🌟💎🐉📚🔥",
  "name": "My Shoppe",
  "keywords": ["digital goods", "indie creator", "music", "books"]
}
```

`keywords` is optional. When present, it is stored in the tenant record and rendered as a `<meta name="keywords">` tag on the main shoppe page.

`redirects` is optional. Each key is a content category (`books`, `music`, `posts`, `albums`, `products`, `appointments`, `subscriptions`) and the value is an external URL. When set, clicking any card in that category sends visitors to that URL instead of the plugin's built-in purchase/download pages. Example:

```json
{
  "uuid": "...",
  "emojicode": "...",
  "name": "My Shoppe",
  "redirects": {
    "books": "https://myauthorsite.com/books",
    "music": "https://mybandcamp.com"
  }
}
```

### books/*/info.json

```json
{
  "title": "My Novel",
  "description": "A gripping tale",
  "price": 9,
  "cover": "front.jpg",
  "keywords": ["fiction", "thriller", "indie author"]
}
```

`keywords` is optional on all `info.json` files. Values are stored as `kw:`-prefixed entries in Sanora's product tags and rendered as `<meta name="keywords">` on that product's pages.

`cover` pins a specific image file as the Sanora cover image. If omitted, the first image in the folder is used.

### music/*/info.json (albums)

```json
{
  "title": "My Album",
  "description": "Debut record",
  "price": 10,
  "cover": "artwork.jpg"
}
```

### music/*.json (standalone track sidecar)

A `.json` file with the same basename as the audio file:

```
music/
  my-track.mp3
  my-track.json    ← { "title": "…", "description": "…", "price": 0 }
```

### posts/*/index.md front matter

Posts support TOML (`+++ … +++`) or YAML (`--- … ---`) front matter:

```toml
+++
title = "On boiling the ocean"
date = "2025-01-12"
preview = "ocean.jpg"
+++
```

`preview` pins a specific image as the post cover. If omitted, the first image in the folder is used. `title` and `date` override folder name and `info.json`.

### products/*/info.json

```json
{
  "title": "Planet Nine T-Shirt",
  "description": "Comfortable cotton tee with logo",
  "price": 25,
  "shipping": 5
}
```

The hero image is resolved automatically: `hero.jpg` or `hero.png` is used if present, otherwise the first image in the folder. Folder numeric prefix (`01-`, `02-`, …) sets display order.

### appointments/*/info.json

```json
{
  "title": "60-Minute Therapy Session",
  "description": "One-on-one counseling",
  "price": 15000,
  "duration": 60,
  "timezone": "America/New_York",
  "advanceDays": 30,
  "availability": [
    { "day": "Monday", "slots": ["09:00", "10:00", "11:00", "14:00", "15:00"] },
    { "day": "Wednesday", "slots": ["09:00", "10:00", "14:00"] }
  ]
}
```

`price` is in cents. `duration` is minutes per slot. `timezone` is any IANA timezone string. `advanceDays` limits how far ahead slots are shown. `availability` lists days of the week with start times for each slot.

### subscriptions/*/info.json

```json
{
  "title": "Bronze Supporter",
  "description": "Support the work and get exclusive content",
  "price": 500,
  "renewalDays": 30,
  "benefits": [
    "Early access to new releases",
    "Monthly exclusive track",
    "Name in credits"
  ]
}
```

`price` is in cents per period. `renewalDays` is the billing period length (default 30). `benefits` are bullet points shown on the subscribe page. All non-`info.json`, non-image files in the subfolder are uploaded as exclusive artifacts downloadable by active subscribers.

## Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/plugin/shoppe/register` | Owner | Register new tenant |
| `GET`  | `/plugin/shoppe/tenants` | Owner | List all tenants |
| `POST` | `/plugin/shoppe/upload` | UUID+emojicode in archive | Upload goods archive |
| `GET`  | `/plugin/shoppe/:id` | Public | Shoppe HTML page |
| `GET`  | `/plugin/shoppe/:id/goods` | Public | Goods JSON |
| `GET`  | `/plugin/shoppe/:id/goods?category=books` | Public | Filtered goods JSON |
| `GET`  | `/plugin/shoppe/:id/book/:title` | Public | Appointment booking page |
| `GET`  | `/plugin/shoppe/:id/book/:title/slots` | Public | Available slots JSON |
| `GET`  | `/plugin/shoppe/:id/subscribe/:title` | Public | Subscription sign-up page |
| `GET`  | `/plugin/shoppe/:id/membership` | Public | Membership portal |
| `POST` | `/plugin/shoppe/:id/membership/check` | Public | Check subscription status |
| `POST` | `/plugin/shoppe/:id/purchase/intent` | Public | Create Stripe payment intent |
| `POST` | `/plugin/shoppe/:id/purchase/complete` | Public | Record completed purchase |
| `GET`  | `/plugin/shoppe/:id/download/:title` | Public | Ebook download page |
| `GET`  | `/plugin/shoppe/:id/post/:title` | Public | Post reader |
| `GET`  | `/plugin/shoppe/:id/orders` | Owner (signed URL) | Order history page |
| `GET`  | `/plugin/shoppe/:id/payouts` | Owner (signed URL) | Stripe Connect Express onboarding |
| `GET`  | `/plugin/shoppe/:id/payouts/return` | Public | Post-Stripe-Connect confirmation page |

`:id` accepts either UUID or emojicode.

## Payment / Transfer Flow

1. Buyer calls `POST /purchase/intent` → shoppe creates a buyer Addie user and calls `PUT /user/:buyerUuid/processor/stripe/intent` on Addie → returns `{ clientSecret, publishableKey }`
2. Stripe.js confirms payment client-side (no redirect)
3. Client extracts `paymentIntentId` from `clientSecret` (`clientSecret.split('_secret_')[0]`) and posts to `POST /purchase/complete` with `paymentIntentId`
4. Server records the order in Sanora, then fires a **fire-and-forget** `POST ${addieUrl}/payment/${paymentIntentId}/process-transfers` — Addie splits the payment and routes it to the tenant's Stripe account (no auth required on this Addie endpoint)

**Important:** Transfers only flow to the owner after `node shoppe-sign.js payouts` has been run and Stripe Connect onboarding is complete.

## Configuration

```bash
# Base emoji for all tenant emojicodes on this wiki (default: 🛍️🎨🎁)
export SHOPPE_BASE_EMOJI="🏪🎪🎁"

# Sanora port (default: 7243)
export SANORA_PORT=7243
```

## Supported File Types

| Category | Extensions |
|----------|-----------|
| Books    | .epub, .pdf, .mobi, .azw, .azw3 |
| Music    | .mp3, .flac, .m4a, .ogg, .wav |
| Posts    | .md |
| Albums   | .jpg, .jpeg, .png, .gif, .webp, .svg |
| Products | .jpg/.png cover + info.json |

## Storage

Tenant registry: `.shoppe-tenants.json` (gitignored — contains private keys)

Each tenant's goods are stored in Sanora under their own UUID.

## Dependencies

```json
{
  "adm-zip": "^0.5.10",
  "form-data": "^4.0.0",
  "multer": "^1.4.5-lts.1",
  "node-fetch": "^2.6.1",
  "sessionless-node": "^0.9.12"
}
```
