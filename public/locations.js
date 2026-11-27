// Shared by the phone app (browser) and the API (Node).
// Location codes come from the "Address" column, e.g. "1C3-3C,6A3" or
// "PP12-5,PP13-4,1I4-1A, 1FF (Pdr) (5)". Each comma-separated part is one place
// the material is kept. Notes in brackets like "(Pdr)" or "(5)" are kept as notes.

/** Turn any written or scanned location into a comparable code: "1c3-3c " -> "1C3-3C". */
export function normalizeCode(text) {
  return String(text ?? '')
    .replace(/^\s*L:/i, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\(.*$/, '')
    .replace(/\s+/g, '')
    .replace(/^[.,;:]+|[.,;:]+$/g, '') // stray typing like "1B1-2."
    .toUpperCase();
}

/** Split one address part into its location text and any bracketed notes. */
export function splitPart(part) {
  const text = String(part ?? '');
  const note = (text.match(/\([^)]*\)/g) || []).join(' ');
  const base = text
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\(.*$/, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.,;:]+|[.,;:]+$/g, '')
    .trim();
  return { base, note };
}

/** "1C3-3C,6A3" -> [{code:"1C3-3C", label:"1C3-3C", note:""}, {code:"6A3", ...}] */
export function parseAddress(address) {
  const out = [];
  const seen = new Set();
  for (const part of String(address ?? '').split(',')) {
    const { base, note } = splitPart(part);
    if (!base) continue;
    const code = normalizeCode(base);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push({ code, label: base, note });
  }
  return out;
}

/** Rack part of a slot code: "1C3-3C" -> "1C3", "PP12-5" -> "PP12", "6A3" -> "6A3". */
export function rackOf(code) {
  const i = code.indexOf('-');
  return i > 0 ? code.slice(0, i) : code;
}

/**
 * Does a scanned rack/slot label count as this home location?
 * Exact slot match, or a rack-level label ("1C3") for a slot inside it ("1C3-3C").
 */
export function slotMatches(scannedCode, homeCode) {
  if (!scannedCode || !homeCode) return false;
  return scannedCode === homeCode || homeCode.startsWith(scannedCode + '-');
}

/**
 * Replace one location in an address string, leaving every other part exactly as typed.
 * If the new location is already in the address, the old one is simply removed.
 * If the old one isn't there (or fromCode is empty), the new one is added at the end.
 */
export function replaceLocation(address, fromCode, toLabel) {
  const label = String(toLabel ?? '').trim();
  const toCode = normalizeCode(label);
  const parts = String(address ?? '').split(',');
  const codes = parts.map((p) => normalizeCode(splitPart(p).base));
  const alreadyThere = codes.some((c, i) => c === toCode && c !== fromCode && splitPart(parts[i]).base);
  const out = [];
  let replaced = false;

  parts.forEach((part, i) => {
    const { base, note } = splitPart(part);
    if (!replaced && fromCode && base && codes[i] === fromCode) {
      replaced = true;
      if (alreadyThere) return;
      const lead = part.match(/^\s*/)[0];
      out.push(lead + label + (note ? ' ' + note : ''));
      return;
    }
    out.push(part);
  });

  if (!replaced && !alreadyThere && label) out.push(label);
  return out.filter((p) => p.trim() !== '').join(',');
}

/** Sort location codes the way people read them: 1C2 before 1C10. */
export function compareCodes(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/** Key used for one physical container: material SKU + the location it lives in. */
export function statusKey(sku, code) {
  return `${String(sku).trim()}|${code}`;
}

/**
 * Work out what a scanned QR/barcode is.
 * - "L:1C3-3C" (rack labels printed by this app) or any known location code -> rack
 * - a known SKU, "S:220418004", or an order sticker "20648-251205006-100g-4-1" -> bottle
 */
export function classifyScan(text, { skus, codes, racks }) {
  const raw = String(text ?? '').trim();
  if (!raw) return { kind: 'unknown', raw };

  if (/^L:/i.test(raw)) return { kind: 'slot', code: normalizeCode(raw), raw };

  const sMatch = raw.match(/^S:\s*(.+)$/i);
  if (sMatch) return { kind: 'bottle', sku: sMatch[1].trim(), raw };

  if (skus.has(raw)) return { kind: 'bottle', sku: raw, raw };

  const order = raw.match(/^\d+-(\d{5,})-/);
  if (order && skus.has(order[1])) return { kind: 'bottle', sku: order[1], raw, fromOrderSticker: true };

  const code = normalizeCode(raw);
  if (codes.has(code) || racks.has(code)) return { kind: 'slot', code, raw };
  if (skus.has(code)) return { kind: 'bottle', sku: code, raw };

  return { kind: 'unknown', raw };
}
