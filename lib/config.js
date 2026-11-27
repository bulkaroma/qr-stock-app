// All settings can be overridden with Vercel environment variables.
// Defaults point at your existing sheets, so normally you only set the
// Google key and the app PIN.
const env = process.env;
const hasGoogleKey = Boolean(env.GOOGLE_SERVICE_ACCOUNT_JSON || (env.GOOGLE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_PRIVATE_KEY));

export const config = {
  // Demo mode: the app uses a built-in copy of shelf B and never reads or writes Google Sheets.
  // On automatically when no Google key is set (or force with DEMO_MODE=1 / off with DEMO_MODE=0).
  demo: env.DEMO_MODE === '1' || (env.DEMO_MODE !== '0' && !hasGoogleKey && env.MOCK_SHEETS !== '1'),

  // "Shopify_Location_ReOrder Data" -> tab "Central Location Info"
  locationsSheetId: env.LOCATIONS_SHEET_ID || '1Pl3R8PlCYKF9U5av255u5twZUEqSGMoQrSqGXkm1L7U',
  locationsTab: env.LOCATIONS_TAB || 'Central Location Info',
  locationsFirstRow: Number(env.LOCATIONS_FIRST_ROW || 3), // rows 1-2 are headers
  // Columns in that tab (letters)
  skuCol: env.LOCATIONS_SKU_COL || 'A',
  nameCol: env.LOCATIONS_NAME_COL || 'B',
  addressCol: env.LOCATIONS_ADDRESS_COL || 'C',

  // "Exportible Shopify Order Feed" -> tab "QR Sheet" (the day's order lines)
  ordersSheetId: env.ORDERS_SHEET_ID || '1Ro4M9vZ1uSxBa1lE9qV3iHvItJs4G6hxdlc5hxaG1_0',
  ordersTab: env.ORDERS_TAB || 'QR Sheet',

  // Where the app keeps its own two tabs (created automatically on first use).
  appSheetId: env.APP_SHEET_ID || env.LOCATIONS_SHEET_ID || '1Pl3R8PlCYKF9U5av255u5twZUEqSGMoQrSqGXkm1L7U',
  statusTab: env.STATUS_TAB || 'QR App Status',
  logTab: env.LOG_TAB || 'QR App Log',

  // Shared PIN workers type once on each phone. Leave empty to turn off (not recommended).
  pin: env.APP_PIN || '',

  // Pilot: only these racks are used by the app, e.g. "1B1,1B2,1B3,1B4,1B5".
  // Leave empty to use every rack.
  pilotRacks: String(env.PILOT_RACKS || '')
    .split(',')
    .map((r) => r.replace(/\s+/g, '').toUpperCase())
    .filter(Boolean),
};

// "Op ID" lets a phone safely retry a scan after a dropped connection without saving it twice.
export const STATUS_HEADERS = ['Key', 'SKU', 'Material', 'Location', 'Status', 'By', 'Updated', 'Updated (ISO)', 'Note', 'Op ID'];
export const LOG_HEADERS = ['Time', 'Worker', 'Action', 'SKU', 'Material', 'From', 'To', 'Note', 'Time (ISO)', 'Op ID'];
