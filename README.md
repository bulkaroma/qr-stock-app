# Stock Finder

A phone app for the source-bottle shelves. Workers search a SKU, walk to the rack, scan the rack label, then scan the bottle. The app marks the bottle as taken. When they put it back, they scan the bottle and the rack again. If it's the wrong rack, the app tells them where it belongs, or lets them move it there for good, and the address in your Google Sheet updates itself.

It runs on GitHub + Vercel. It reads and writes your existing Google Sheets directly. There are no npm packages to install and no database to set up.

---

## Demo mode (nothing touches Google Sheets)

If no Google key is added in Vercel, the app runs as a **demo** automatically:

- It uses a **built-in copy of shelf B** (racks 1B1–1B5, 74 bottles, copied from Central Location Info on 27 Nov 2026) and a sample order list. It doesn't contain customer names.
- Every scan is kept **on that phone only**. Nothing is read from or written to Google Sheets.
- Each phone has its own demo, so phones don't see each other's scans.
- **Reset demo** in the yellow bar puts every bottle back as it started.
- The shelf B stickers (Shelf-B-pilot-stickers.pdf) work with it, and it also works offline.

**Deploy the demo:**

1. **Unzip** `qr-stock-app.zip`.
2. **GitHub:** create a new **private** repository (no README). Click **uploading an existing file** and drag in everything *inside* the `qr-stock-app` folder, so that `api`, `lib`, `public`, `package.json` and `vercel.json` sit at the top level. Then click **Commit changes**.
3. **Vercel:** click **Add New… → Project**, import the repository, and set **Framework Preset → Other**. Under **Environment Variables**, add only `APP_PIN` (for example `4827`). Don't add any Google key. Click **Deploy**.
4. **Check:** open `https://YOUR-APP.vercel.app/api/health`. It should show `"demo": true`.
5. **Phones:** open the link, type a name and the PIN, then **Add to Home Screen**.

To go live later, follow **Setup** below. Once the Google key is added, demo mode turns off by itself.

---

## What it uses in your sheets

| Sheet | Tab | What the app does |
|---|---|---|
| Shopify_Location_ReOrder Data | **Central Location Info** | Reads SKU (A), Material Name (B), Address (C). On a **move**, it rewrites only the moved part of that SKU's Address cell (for example `1C3-3C,6A3` → `2B1-1A,6A3`). Nothing else is touched. The old address is saved in the log. |
| Shopify_Location_ReOrder Data | **QR App Status** *(new, created automatically)* | One row per container (SKU + location): IN or OUT, who, and when. |
| Shopify_Location_ReOrder Data | **QR App Log** *(new, created automatically)* | Every take, put-back and move, with time and worker name. |
| Exportible Shopify Order Feed | **QR Sheet** | Read only. Builds "Today's list", grouped by material and sorted by rack. |

Each comma-separated part of an Address is treated as one place where a container of that material lives. Notes in brackets such as `(Pdr)` or `(5)` are kept as notes.

---

## Setup (about 20 minutes, once)

### 1. Give the app a Google key

1. Go to <https://console.cloud.google.com/> and create a project, for example *stock-finder*.
2. Open **APIs & Services → Library**, search **Google Sheets API**, and click **Enable**.
3. Open **IAM & Admin → Service Accounts → Create service account**. Name it *stock-finder* and click **Done**. It doesn't need any roles.
4. Click the new service account, then **Keys → Add key → Create new key → JSON**. A `.json` file downloads. Keep it private: it works like a password.
5. Copy the service account's email address. It looks like `stock-finder@your-project.iam.gserviceaccount.com`.
6. In Google Sheets, click **Share** and add that email:
   - **Shopify_Location_ReOrder Data** → **Editor**. The app writes status, log and moves here.
   - **Exportible Shopify Order Feed** → **Viewer**.

> If Google says key creation is blocked, your Workspace admin has a policy that stops it (`iam.disableServiceAccountKeyCreation`). Ask them to allow it for this project.

### 2. Put the code on GitHub

1. Create a **private** repository on GitHub, for example `stock-finder`. Keep it private, because the sheet IDs are in `lib/config.js`.
2. Click **Add file → Upload files**, drag in everything from this folder, and **Commit**.

### 3. Deploy on Vercel

1. Go to <https://vercel.com/new>, import the GitHub repo, and leave **Framework Preset** on **Other**. Use a **Pro** account: Vercel's free Hobby plan is for personal, non-commercial use only.
2. Before clicking Deploy, open **Environment Variables** and add:

   | Name | Value |
   |---|---|
   | `GOOGLE_SERVICE_ACCOUNT_JSON` | Open the downloaded `.json` file in a text editor and paste its **whole contents** |
   | `APP_PIN` | A PIN workers type once per phone, e.g. `4827` |
   | `PILOT_RACKS` | *Only while piloting:* `1B1,1B2,1B3,1B4,1B5` (see “Running the shelf B pilot”) |

3. Click **Deploy**. You get a link like `https://stock-finder.vercel.app`.
   *If you added the variables after deploying, go to **Deployments → ⋯ → Redeploy**.*

### 4. Check the connection

Open this in a browser, using your link and PIN:

```
https://YOUR-APP.vercel.app/api/health?deep=1&pin=YOUR_PIN
```

All three checks should say `"ok": true`, with your material and order-line counts. This also creates the **QR App Status** and **QR App Log** tabs. If a check fails, the message tells you what's wrong (usually a sheet that isn't shared with the service-account email).

### 5. Print labels

Open `https://YOUR-APP.vercel.app/labels` on a computer.

- **Racks and their bottles** (default): one sticker per rack (`1C3`), each followed by the stickers for that rack's bottles. Each bottle sticker shows its slot (`1C3-3C`). The QR on a bottle sticker holds the SKU.
- **Racks only** / **Bottles only** print one kind. Rack stickers can also be one per slot if you ever want them (**Rack stickers → One per slot**).
- Type in **Only racks starting with** to print one shelf at a time (e.g. `1C`).
- **Add codes by hand** prints stickers for racks that have nothing listed yet (e.g. a new rack `1B6`).
- Sizes: A4 sheet (24 per page, 64×33 mm) or a label printer (50×30 or 38×25 mm).

Use polyester or vinyl labels, not paper, so spills don't smudge them.

### 6. Set up the phones

Open the link on each phone, type the worker's name and the PIN, then **Add to Home Screen** (Safari: Share button; Chrome: ⋮ menu). Allow camera access when asked.

---

## Running the shelf B pilot (racks 1B1–1B5)

Start with one shelf. Shelf B holds 74 source bottles, one per slot, and gets roughly 20+ order lines a day.

1. In Vercel → Settings → Environment Variables, add `PILOT_RACKS` = `1B1,1B2,1B3,1B4,1B5`, then **Redeploy**.
2. Print **Shelf-B-pilot-stickers.pdf** on A4 sticker sheets (4 pages, 24 per page, 64 × 33 mm). It has **one sticker per rack** (thick black border: `1B1` … `1B5`), each followed by the stickers for that rack's bottles in slot order.
   - Stick each rack sticker on the front of its rack.
   - Stick each bottle sticker on its bottle. The sticker shows its slot (e.g. `1B5-1A`).
   You can reprint from `/labels` → **Racks and their bottles**, one per rack, with **Pilot racks only** ticked.
3. While the pilot is on, search, Today's list and scanning only cover racks 1B1–1B5. Anything else shows “isn't on the pilot racks, handle it the usual way”.
4. With one sticker per rack, the app checks the **rack**, and the screen tells the worker the exact slot, e.g. “Put it in `1B5-1A`”. It can't tell if a bottle went into the wrong slot on the right rack.
5. When a bottle is moved to another rack, the app asks which slot (e.g. `2A`) so the Address column stays exact.
6. To end the pilot, delete `PILOT_RACKS`, redeploy, and print stickers for the next racks.

---

## Working without signal

- **The app opens offline.** The app and the camera scanner are saved on each phone the first time it's opened with a connection. After that it opens and scans even with no signal.
- **Each phone keeps a copy** of the rack and bottle info and today's list. It refreshes whenever there's a connection.
- **Every scan is saved on the phone first.** With signal it reaches the sheet within a second or two. Without signal the header shows **Offline · 3 waiting** and the worker carries on. Waiting scans send by themselves as soon as the connection is back (the app also checks every 20 seconds). If the app is closed or the phone switches off, the scans stay on the phone and send the next time the app is opened with signal.
- **The sheet records when the scan happened**, not when it arrived. Scans that arrive late get a note in **QR App Log**, e.g. *saved offline, synced 47 min later*.
- **The newest scan wins.** If an offline phone and an online phone both scan the same bottle, the later scan sets the status. The older one is still written to the log, marked *not applied: newer scan by Amit already saved*.
- **A dropped connection never saves a scan twice.** Each scan has an ID, stored in the **Op ID** column of both tabs. If the reply is lost and the phone sends the scan again, it's recognised and not saved a second time.
- **Refused scans are shown, not lost.** If the sheet refuses a waiting scan (for example another phone moved that bottle first), the header shows **1 not saved**. Tap it to see what and why, then check the bottle and scan again.
- **Limits:**
  - A phone must open the app online once before it can work offline.
  - While offline, a phone doesn't see other phones' scans.
  - Waiting scans only send while the app is open.

If you set the app up before this version, the **Op ID** column is added to the two tabs automatically. Nothing else changes.

---

## Settings (optional Vercel environment variables)

| Variable | Default | Use |
|---|---|---|
| `LOCATIONS_SHEET_ID` | your Shopify_Location_ReOrder Data sheet | Where materials and addresses live |
| `LOCATIONS_TAB` | `Central Location Info` | |
| `LOCATIONS_FIRST_ROW` | `3` | First data row (rows 1–2 are headers) |
| `LOCATIONS_SKU_COL` / `_NAME_COL` / `_ADDRESS_COL` | `A` / `B` / `C` | If you ever move columns |
| `ORDERS_SHEET_ID` | your Exportible Shopify Order Feed sheet | |
| `ORDERS_TAB` | `QR Sheet` | |
| `APP_SHEET_ID` | same as `LOCATIONS_SHEET_ID` | Put the Status/Log tabs in a different spreadsheet |
| `STATUS_TAB` / `LOG_TAB` | `QR App Status` / `QR App Log` | |
| `PILOT_RACKS` | *(empty: all racks)* | Limit the app to some racks, e.g. `1B1,1B2,1B3,1B4,1B5` |

---

## Try it on your computer first (optional)

With Node.js 20+ installed:

```
npm run dev:mock     # sample data, PIN 1234 → http://localhost:3000
npm test             # 24 automated checks
```

To run against your real sheets locally, create a `.env` file (see `.env.example`) and run `npm run dev`.

---

## Files

```
public/        the phone app (index.html, app.js, style.css) and label page (labels.html, labels.js)
public/locations.js   address parsing and scan rules, shared by app and server
api/           Vercel functions: data, today, action, health
lib/           Google Sheets access and settings
dev/           local test server and sample data
test/          automated tests
```

The camera scanner (html5-qrcode) and the QR generator (qrcode-generator) load from the jsDelivr CDN, so the phones need internet. They need it anyway to reach the sheet.
