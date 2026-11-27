// GET /api/data — every material with its address, plus which containers are out.
import { api } from '../lib/http.js';
import { readEverything } from '../lib/store.js';
import { config } from '../lib/config.js';
import demo from '../lib/demo-data.js';

export default api(['GET'], async () => {
  if (config.demo) {
    // Built-in copy; every phone starts with all bottles in place.
    return { materials: demo.materials, status: [], pilotRacks: demo.pilotRacks, demo: true, copiedOn: demo.copiedOn, serverTime: new Date().toISOString() };
  }
  const { materials, status } = await readEverything();
  return {
    materials: materials.map(({ sku, name, address }) => ({ sku, name, address })),
    status: [...status.values()].map(({ row, ...s }) => s),
    pilotRacks: config.pilotRacks,
    serverTime: new Date().toISOString(),
  };
});
