// GET /api/today — the day's order lines from "QR Sheet", grouped by material.
import { api } from '../lib/http.js';
import { readToday } from '../lib/store.js';
import { config } from '../lib/config.js';
import demo from '../lib/demo-data.js';

export default api(['GET'], async () => (config.demo ? demo.today : readToday()));
