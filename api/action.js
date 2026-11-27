// POST /api/action — take a bottle, put it back, or move it to a new rack.
// Body: { action: "take" | "return" | "move", sku, code, fromCode, toLabel, worker, at, iso, opId, note }
//
// Phones may send actions late (saved while offline) and may retry after a dropped
// connection, so:
//  - opId: an action already saved with this ID is not saved again;
//  - iso:  the time the scan happened on the phone; if a newer scan of the same bottle
//          is already saved, the late one is only written to the log.
import { api, ApiError } from '../lib/http.js';
import { config } from '../lib/config.js';
import { findMaterial, readMaterials, readStatus, updateAddress, writeStatus, appendLog, makeStatus } from '../lib/store.js';
import { parseAddress, normalizeCode, statusKey } from '../public/locations.js';

const clean = (v, max = 80) => String(v ?? '').trim().slice(0, max);
const strip = ({ row, ...s }) => s;
const joinNotes = (...parts) => parts.filter(Boolean).join(' · ');

async function locationOf(material, code) {
  const wanted = normalizeCode(code);
  let loc = parseAddress(material.address).find((l) => l.code === wanted);
  if (!loc) {
    // Someone may have just moved it from another phone — re-read before giving up.
    const fresh = (await readMaterials({ fresh: true })).bySku.get(material.sku);
    if (fresh) {
      material = fresh;
      loc = parseAddress(fresh.address).find((l) => l.code === wanted);
    }
  }
  if (!loc) {
    throw new ApiError(409, `${code} is no longer listed for ${material.name} (address now: "${material.address}").`);
  }
  return { loc, material };
}

/** The phone's scan time, if believable; otherwise now. */
function scanTime(clientIso, nowMs) {
  const t = Date.parse(clientIso);
  if (!Number.isFinite(t)) return new Date(nowMs).toISOString();
  if (t > nowMs + 10 * 60_000) return new Date(nowMs).toISOString(); // phone clock ahead: don't trust
  if (t < nowMs - 30 * 86_400_000) return new Date(nowMs).toISOString(); // older than 30 days
  return new Date(t).toISOString();
}

function delayNote(iso, nowMs) {
  const mins = Math.round((nowMs - Date.parse(iso)) / 60_000);
  if (mins < 2) return '';
  const span = mins < 60 ? `${mins} min` : mins < 1440 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${Math.floor(mins / 1440)} days`;
  return `saved offline, synced ${span} later`;
}

const newer = (a, b) => Date.parse(a) > Date.parse(b);

export default api(['POST'], async ({ body }) => {
  if (config.demo) throw new ApiError(400, 'Demo mode: scans are kept on each phone and not sent anywhere.');
  const action = clean(body.action, 10);
  const worker = clean(body.worker, 60);
  if (!worker) throw new ApiError(400, 'Worker name is missing');
  if (!body.sku) throw new ApiError(400, 'SKU is missing');

  const nowMs = Date.now();
  const iso = scanTime(body.iso, nowMs);
  const at = clean(body.at, 40) || iso.replace('T', ' ').slice(0, 19);
  const opId = clean(body.opId, 64);
  const note = joinNotes(clean(body.note, 200), delayNote(iso, nowMs));
  let material = await findMaterial(clean(body.sku, 40));
  const out = (status, extra = {}) => ({
    ok: true,
    status: status ? [strip(status)] : [],
    removedKeys: [],
    material: { sku: material.sku, name: material.name, address: material.address },
    ...extra,
  });

  const all = await readStatus();

  // Already saved? (the phone lost the reply and is retrying)
  if (opId) {
    const done = [...all.values()].find((s) => s.opId === opId);
    if (done) {
      const from = body.fromCode ? normalizeCode(body.fromCode) : '';
      const removedKeys = action === 'move' && from && from !== done.code ? [statusKey(material.sku, from)] : [];
      return out(done, { duplicate: true, removedKeys });
    }
  }

  if (action === 'take' || action === 'return') {
    const found = await locationOf(material, body.code);
    material = found.material;
    const taking = action === 'take';
    const key = statusKey(material.sku, found.loc.code);
    const current = all.get(key);
    const logEntry = {
      at, iso, worker, opId,
      action: taking ? 'TAKE' : 'RETURN',
      sku: material.sku,
      material: material.name,
      from: taking ? found.loc.label : '',
      to: taking ? '' : found.loc.label,
    };
    if (current?.iso && newer(current.iso, iso)) {
      // A later scan from another phone is already saved: keep it, just record this one.
      await appendLog({ ...logEntry, note: joinNotes(note, `not applied: newer scan by ${current.by} already saved`) });
      return out(current, { stale: true });
    }
    const saved = await writeStatus(
      makeStatus({ sku: material.sku, material: material.name, code: found.loc.code, status: taking ? 'OUT' : 'IN', by: worker, at, iso, note, opId }),
      { all },
    );
    await appendLog({ ...logEntry, note });
    return out(saved);
  }

  if (action === 'move') {
    const toLabel = clean(body.toLabel, 60);
    if (!normalizeCode(toLabel)) throw new ApiError(400, 'New location is missing');
    let fromCode = '';
    let fromLabel = '';
    if (body.fromCode) {
      const found = await locationOf(material, body.fromCode);
      material = found.material;
      fromCode = found.loc.code;
      fromLabel = found.loc.label;
    }
    const changed = await updateAddress(material.sku, fromCode, toLabel);
    material = { ...material, address: changed.newAddress };
    const toCode = normalizeCode(toLabel);
    const current = fromCode ? all.get(statusKey(material.sku, fromCode)) : null;
    const moveNote = joinNotes(fromCode ? `Moved from ${fromLabel}` : 'New location', note);
    // The bottle's home changes either way. If a newer take/return was saved meanwhile,
    // keep that status (IN/OUT, who, when) on the new location.
    const keep = current?.iso && newer(current.iso, iso);
    const saved = await writeStatus(
      makeStatus({
        sku: material.sku, material: material.name, code: toCode,
        status: keep ? current.status : 'IN',
        by: keep ? current.by : worker,
        at: keep ? current.at : at,
        iso: keep ? current.iso : iso,
        note: moveNote,
        opId,
      }),
      { replaceKey: fromCode ? statusKey(material.sku, fromCode) : undefined, all },
    );
    await appendLog({
      at, iso, worker, opId,
      action: 'MOVE',
      sku: material.sku,
      material: material.name,
      from: fromLabel,
      to: toLabel,
      note: joinNotes(`Address was "${changed.oldAddress}" → now "${changed.newAddress}"`, note),
    });
    return out(saved, { removedKeys: fromCode && fromCode !== toCode ? [statusKey(material.sku, fromCode)] : [] });
  }

  throw new ApiError(400, `Unknown action "${action}"`);
});
