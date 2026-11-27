// GET /api/health — is the app set up?
// Open /api/health?deep=1&pin=YOURPIN in a browser to test access to your sheets.
import { api } from '../lib/http.js';
import { config } from '../lib/config.js';
import { backend, a1, ensureTabs } from '../lib/store.js';

async function check(label, fn) {
  try {
    return { label, ok: true, detail: await fn() };
  } catch (e) {
    return { label, ok: false, detail: e.message };
  }
}

export default api(
  ['GET'],
  async ({ req, query }) => {
    const out = {
      ok: true,
      demo: config.demo,
      pinRequired: Boolean(config.pin),
      pilotRacks: config.pilotRacks,
      mock: process.env.MOCK_SHEETS === '1',
    };
    const pinOk = !config.pin || req.headers['x-app-pin'] === config.pin || query.pin === config.pin;
    if (query.deep && pinOk && config.demo) {
      out.checks = [{ label: 'Demo mode', ok: true, detail: 'Using the built-in copy of shelf B. Google Sheets is not read or written.' }];
    } else if (query.deep && pinOk) {
      const b = await backend();
      out.checks = [
        await check(`Read "${config.locationsTab}"`, async () => {
          const rows = await b.getValues(config.locationsSheetId, a1(config.locationsTab, `A${config.locationsFirstRow}:C`));
          return `${rows.filter((r) => r[0]).length} materials`;
        }),
        await check(`Read "${config.ordersTab}"`, async () => {
          const rows = await b.getValues(config.ordersSheetId, a1(config.ordersTab, 'A2:A'));
          return `${rows.filter((r) => r[0]).length} order lines`;
        }),
        await check(`Create/find "${config.statusTab}" and "${config.logTab}" tabs`, async () => {
          await ensureTabs();
          return 'ready';
        }),
      ];
      out.ok = out.checks.every((c) => c.ok);
    }
    return out;
  },
  { public: true },
);
