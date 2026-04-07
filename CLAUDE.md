# wiki-plugin-agora — Developer Documentation

Multi-tenant digital goods agora for Federated Wiki, powered by Sanora.

**Current version**: 0.0.43

## Architecture

Follows the Service-Bundling Plugin Pattern. Each tenant (seller/creator) gets their own Sanora user account, identified by a UUID and an 8-emoji emojicode (same format as BDO: 3 base + 5 unique from the EMOJI_PALETTE).

### Tenant Identity

Each tenant has:
- **UUID** — their Sanora user UUID
- **Emojicode** — 8-emoji human-readable identifier (e.g. `🛍️🎨🎁🌟💎🐉📚🔥`)

The first 3 emoji are fixed per wiki instance (`AGORA_BASE_EMOJI`, default `🛍️🎨🎁`). The last 5 are unique per tenant.

### Tenant Lifecycle

1. Wiki owner registers a tenant: `POST /plugin/agora/register { name }`
   - Plugin creates a Sanora user + an Addie user for the tenant
   - Generates emojicode + owner keypair (secp256k1 via sessionless)
   - Stores `{ uuid, emojicode, name, keys, addieKeys, ownerPubKey }` in `~/.agora/tenants.json`
   - Owner private key is delivered once via a single-use starter bundle download (bundleToken)
2. Tenant runs `node agora-sign.js init` — moves private key to `~/.agora/keys/<uuid>.json`
3. Tenant runs `node agora-sign.js payouts` — completes Stripe Connect Express onboarding
4. Tenant builds their archive and runs `node agora-sign.js` to sign and zip
5. Tenant drags the zip onto the wiki plugin widget
6. Plugin verifies `uuid + emojicode + owner signature`, processes all goods into Sanora
7. Agora accessible at `/plugin/agora/:uuid` or `/plugin/agora/:emojicode`

### agora-sign.js commands

| Command | Description |
|---------|-------------|
| `node agora-sign.js init` | Move `agora-key.json` to `~/.agora/keys/<uuid>.json` (no npm needed) |
| `node agora-sign.js` | Sign manifest + create upload.zip |
| `node agora-sign.js orders [wiki-url]` | Generate signed orders URL (5-min expiry), open in browser |
| `node agora-sign.js payouts [wiki-url]` | Generate signed payouts URL, redirect to Stripe Connect onboarding |

## Archive Format

```
my-agora.zip
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
  bio/
    photo.jpg             ← optional creator portrait (up to 1024×1024 px)
      chapter-draft.pdf
```

### manifest.json

```json
{
  "uuid": "your-uuid-from-registration",
  "emojicode": "🛍️🎨🎁🌟💎🐉📚🔥",
  "name": "My Agora",
  "keywords": ["digital goods", "indie creator", "music", "books"],
  "description": "Independent music, books, and more from a Planet Nine creator.",
  "lightMode": false,
  "email": "seller@example.com"
}
```

`keywords` is optional. Stored in the tenant record and rendered as a `<meta name="keywords">` tag.

`redirects` is optional. Each key is a content category and the value is an external URL. Clicking any card in that category sends visitors to that URL instead of the plugin's built-in pages.

`description` is optional. A one-sentence description of the agora, used in `og:description` and `<meta name="description">` for link previews and SEO. If omitted, a description is auto-generated from the available content sections (e.g. "Jane Doe — books, music, and more. Available now.").

`mirloUrl` is optional. A Mirlo artist page URL (e.g. `https://mirlo.space/bury-the-needle`). On every upload, the agora fetches the artist's published albums and tracks from the Mirlo public API and merges them into the Canimus feeds (`/feed/canimus` and `/feed/canimus.json`) alongside locally-uploaded music. The result is cached in `tenants.json` as `mirloFeed` and refreshed on each re-upload.

`email` is optional. The tenant's notification email address. When set, the server sends a notification email for every purchase, booking, or subscription. Stored in `tenants.json` and updated on every re-upload.

`lightMode` is optional (default `false`). When `true`, the agora page uses light mode styling (white cards, `#f5f5f7` background, `#0066cc` accent). Default is dark mode (`#0f0f12` background, `#7ec8e3` accent). Stored in `tenants.json` and applied on every page load — no re-upload needed once set.

`bio` is optional. A creator profile displayed above the section cards on the home tab. Fields: `name` (string), `title` (string — role/tagline), `description` (string, max 2048 characters). The image is read from a `bio/` subfolder in the archive (first image found, up to 1024×1024 px). Both `agora-sign.js` and the server validate the description length and image dimensions. Stored in `tenants.json` as `{ name, title, description, imageExt }`. Image served at `/plugin/agora/:id/bio/image`.

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

**Note:** If the image upload fails (e.g. 413 from nginx), the product metadata is still recorded in Sanora and the upload result still counts as a success with a warning. Re-uploading the archive will push the image without duplicating the product entry.

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
  ],
  "bookingForm": [
    { "id": "event_type",  "label": "Type of event",   "type": "text",     "required": true },
    { "id": "event_date",  "label": "Event date",       "type": "date",     "required": true },
    { "id": "location",    "label": "Location / venue", "type": "text" },
    { "id": "guests",      "label": "Expected guests",  "type": "number" },
    { "id": "details",     "label": "Anything else?",   "type": "textarea" }
  ],
  "bookingEmail": "bookings@example.com"
}
```

`price` is in cents. `duration` is minutes per slot. `timezone` is any IANA timezone string. `advanceDays` limits how far ahead slots are shown. `availability` lists days of the week with start times for each slot.

`availability` and `bookingForm` are both optional and independent:
- **`availability` only** — office-hours scheduler (current behavior)
- **`bookingForm` only** — inquiry/quote form with no fixed price or slots (e.g. face painting, custom work)
- **Both** — scheduler shown first, inquiry form shown below with an "Or send an inquiry" divider

`bookingForm` is an array of field descriptors `{ id, label, type, required, placeholder, options }`. Supported types: `text`, `textarea`, `number`, `date`, `email`, `tel`, `select` (with `options: [...]`). The form always appends Name and Email fields automatically.

`bookingEmail` (optional) — override address for inquiry emails. Falls back to `manifest.json` `email` if omitted.

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
| `POST` | `/plugin/agora/register` | Owner | Register new tenant |
| `GET`  | `/plugin/agora/tenants` | Owner | List all tenants |
| `POST` | `/plugin/agora/upload` | UUID+emojicode in archive | Upload goods archive (returns `{ jobId }` immediately) |
| `GET`  | `/plugin/agora/upload/progress/:jobId` | Public | SSE stream of upload progress events |
| `GET`  | `/plugin/agora/:id` | Public | Agora HTML page |
| `GET`  | `/plugin/agora/:id/goods` | Public | Goods JSON |
| `GET`  | `/plugin/agora/:id/goods?category=books` | Public | Filtered goods JSON |
| `GET`  | `/plugin/agora/:id/music/feed` | Public | Music feed `{ albums, tracks }` built from Sanora products |
| `GET`  | `/plugin/agora/:id/feed/canimus` | Public | Canimus RSS 2.0 + iTunes feed for music distribution |
| `GET`  | `/plugin/agora/:id/feed/canimus.json` | Public | Canimus JSON feed (`application/canimus+json`) for the dolores audio player |
| `GET`  | `/plugin/agora/:id/bio/image` | Public | Creator bio portrait image |
| `GET`  | `/plugin/agora/:id/book/:title` | Public | Appointment booking page (standalone) |
| `GET`  | `/plugin/agora/:id/book/:title/slots` | Public | Available slots JSON |
| `GET`  | `/plugin/agora/:id/subscribe/:title` | Public | Subscription sign-up page (standalone) |
| `GET`  | `/plugin/agora/:id/membership` | Public | Membership portal |
| `POST` | `/plugin/agora/:id/membership/check` | Public | Check subscription status |
| `POST` | `/plugin/agora/:id/purchase/intent` | Public | Create Stripe payment intent |
| `POST` | `/plugin/agora/:id/purchase/complete` | Public | Record completed purchase |
| `GET`  | `/plugin/agora/:id/download/:title` | Public | Ebook download page |
| `GET`  | `/plugin/agora/:id/post/:title` | Public | Post reader |
| `GET`  | `/plugin/agora/:id/orders` | Owner (signed URL) | Order history page |
| `GET`  | `/plugin/agora/:id/payouts` | Owner (signed URL) | Stripe Connect Express onboarding |
| `GET`  | `/plugin/agora/:id/payouts/return` | Public | Post-Stripe-Connect confirmation page |

`:id` accepts either UUID or emojicode.

## Upload Flow (SSE Progress)

The upload endpoint is non-blocking. The client POSTs the archive and immediately gets `{ jobId }`. It then opens an `EventSource` to `/plugin/agora/upload/progress/:jobId` and receives a stream of events:

| Event | Data |
|-------|------|
| `start` | `{ total, name }` — total item count and agora name |
| `progress` | `{ current, total, label }` — item number and human-readable label |
| `warning` | `{ message }` — non-fatal issue (e.g. image upload failed) |
| `complete` | `{ success, books, music, posts, … }` — final result counts |
| `error` | `{ message }` — fatal upload failure |

The progress stream is buffered for late-connecting clients. Jobs are cleaned up after 15 minutes.

## Agora Page UI

The agora page is a single-page app generated server-side by `generateAgoraHTML`. All tabs are lazy-initialized on first open.

### Tabs and their UI patterns

| Tab | Pattern |
|-----|---------|
| All | Card grid of everything |
| Books | Card grid → buy page |
| Music | Album grid → track list → fixed player bar |
| Posts | Series cards → numbered parts list; standalones below |
| Albums | Card grid |
| Products | Card grid → buy page |
| Videos | Card grid with inline player modal |
| Appointments | Inline date strip → slot picker → booking form → Stripe |
| Infuse | Inline tier cards with benefits → recovery key → Stripe |

### Music Player

The music tab fetches `/music/feed` on first open (lazy). The feed is built from Sanora products with `category: 'music'`. Products with multiple audio artifacts are treated as albums; single-artifact products are standalone tracks.

The player bar is fixed at the bottom of the page and is always dark regardless of `lightMode`. Track titles default to "Track 1", "Track 2", etc. because Sanora stores artifacts by UUID (original filenames are not preserved).

### Posts Hierarchy

Post series are detected server-side by `category: 'post-series'` products. Parts are linked by `series:SeriesTitle` and `part:N` tags. The hierarchy is pre-computed in `generateAgoraHTML` and embedded as `_postsRaw` JSON so the client does no extra fetching.

### Inline Subscriptions and Appointments

Subscriptions and appointments are fully handled inline on the agora page — no navigation to separate pages. The full payment flow (recovery key → Stripe Elements → confirmation) runs inside expanding panels under each tier/appointment card. Data (`productId`, `renewalDays`, `benefits`, `timezone`, `duration`) is fetched from Sanora artifact JSON during `getAgoraGoods` and embedded in the page.

## Theming

The agora page is **dark mode by default**. All colors use CSS custom properties defined in `:root`:

| Variable | Dark | Light |
|----------|------|-------|
| `--bg` | `#0f0f12` | `#f5f5f7` |
| `--card-bg` | `#18181c` | `white` |
| `--accent` | `#7ec8e3` | `#0066cc` |
| `--text` | `#e8e8ea` | `#1d1d1f` |
| `--border` | `#333` | `#ddd` |

Set `"lightMode": true` in `manifest.json` and re-upload to switch an agora to light mode. The flag is stored in `tenants.json` so it persists across re-uploads. The music player bar is always dark in both modes.

## UUID Alias / Redis Reset Recovery

If Sanora's Redis is cleared, the tenant's UUID changes on the next `sanoraEnsureUser` call. The server handles this automatically:

1. The old UUID is kept in `tenants.json` as a forwarding alias: `{ "old-uuid": "new-uuid-string", "new-uuid": { ...fullRecord } }`
2. `getTenantByIdentifier` follows string values as aliases
3. All subsequent uploads and page loads use the new UUID transparently

If you encounter `Unknown UUID` errors after a Redis reset, manually add `"old-uuid": "new-uuid"` to `~/.agora/tenants.json`.

## Resilience Features

- **`sanoraCreateProductResilient`** — wraps `sanoraCreateProduct`. On 404/not-found mid-upload (Redis cleared), calls `sanoraEnsureUser`, updates `tenant.uuid`, and retries once.
- **`fetchWithRetry`** — wraps `fetch`. On 429 Too Many Requests, backs off exponentially (1s → 2s → 4s) up to 3 retries.
- **Image upload isolation** — product image upload failures are caught independently; the product entry is always recorded even if the image fails. A warning is emitted so the user can re-upload to fix just the image.

## Payment / Transfer Flow

1. Buyer calls `POST /purchase/intent` → agora creates a buyer Addie user and calls `PUT /user/:buyerUuid/processor/stripe/intent` on Addie → returns `{ clientSecret, publishableKey }`
2. Stripe.js confirms payment client-side (no redirect)
3. Client extracts `paymentIntentId` from `clientSecret` (`clientSecret.split('_secret_')[0]`) and posts to `POST /purchase/complete` with `paymentIntentId`
4. Server records the order in Sanora, then fires a **fire-and-forget** `POST ${addieUrl}/payment/${paymentIntentId}/process-transfers` — Addie splits the payment and routes it to the tenant's Stripe account

**Important:** Transfers only flow to the owner after `node agora-sign.js payouts` has been run and Stripe Connect onboarding is complete.

## Configuration

```bash
# Base emoji for all tenant emojicodes on this wiki (default: 🛍️🎨🎁)
export AGORA_BASE_EMOJI="🏪🎪🎁"

# Sanora port (default: 7243)
export SANORA_PORT=7243
```

## nginx Requirements

The allyabase server's nginx must allow large uploads for books, audio, and images:

```nginx
client_max_body_size 50M;
```

Without this, epub/audio artifact uploads and large cover images will fail with 413. Apply to the relevant `server {}` block and reload: `sudo nginx -t && sudo systemctl reload nginx`.

## Supported File Types

| Category | Extensions |
|----------|-----------|
| Books    | .epub, .pdf, .mobi, .azw, .azw3 |
| Music    | .mp3, .flac, .m4a, .ogg, .wav |
| Posts    | .md |
| Albums   | .jpg, .jpeg, .png, .gif, .webp, .svg |
| Products | .jpg/.png cover + info.json |

## Storage

- `~/.agora/tenants.json` — tenant registry (private keys + UUID aliases — gitignored)
- `~/.agora/buyers.json` — buyer Addie keys, keyed by `recoveryKey + productId`
- `~/.agora/config.json` — plugin config (sanoraUrl)

Each tenant's goods are stored in Sanora under their own UUID.

## Dependencies

```json
{
  "adm-zip": "^0.5.10",
  "form-data": "^4.0.0",
  "multer": "^1.4.5-lts.1",
  "node-fetch": "^2.6.1",
  "sessionless-node": "latest"
}
```
