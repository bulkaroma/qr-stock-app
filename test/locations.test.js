import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAddress, normalizeCode, replaceLocation, slotMatches, rackOf, classifyScan } from '../public/locations.js';

test('parses real addresses from Central Location Info', () => {
  assert.deepEqual(parseAddress('1C3-3C,6A3').map((l) => l.code), ['1C3-3C', '6A3']);
  assert.deepEqual(parseAddress('1D2-2A, 6FB-1').map((l) => l.code), ['1D2-2A', '6FB-1']);
  const ambrox = parseAddress('PP12-5,PP13-4,1I4-1A, 1FF (Pdr) (5)');
  assert.deepEqual(ambrox.map((l) => l.code), ['PP12-5', 'PP13-4', '1I4-1A', '1FF']);
  assert.equal(ambrox[3].note, '(Pdr) (5)');
  assert.deepEqual(parseAddress('PP2-1,1I4-5B, FF (pdr)  (63)').map((l) => l.code), ['PP2-1', '1I4-5B', 'FF']);
  assert.deepEqual(parseAddress('1FF supply rack').map((l) => [l.code, l.label]), [['1FFSUPPLYRACK', '1FF supply rack']]);
  assert.deepEqual(parseAddress('1F3-2C ,7B2').map((l) => l.code), ['1F3-2C', '7B2']);
  assert.deepEqual(parseAddress('PP5-3, 1E4-3B(Pdr),6F').map((l) => l.code), ['PP5-3', '1E4-3B', '6F']);
  assert.deepEqual(parseAddress('Refridgerator-D,7B1').map((l) => l.code), ['REFRIDGERATOR-D', '7B1']);
  assert.deepEqual(parseAddress('1i-1, FF (4)').map((l) => l.code), ['1I-1', 'FF']);
  assert.deepEqual(parseAddress('').length, 0);
  assert.deepEqual(parseAddress('1FF-Right ').map((l) => l.code), ['1FF-RIGHT']);
  // shelf B rows from the real sheet
  assert.deepEqual(parseAddress('1B1-2.').map((l) => [l.code, l.label]), [['1B1-2', '1B1-2']]);
  assert.deepEqual(parseAddress('1C2-3B,7A2,1B1').map((l) => l.code), ['1C2-3B', '7A2', '1B1']);
  assert.deepEqual(parseAddress('PP10-7, 1B5-4A (pdr),8B5').map((l) => l.code), ['PP10-7', '1B5-4A', '8B5']);
  assert.deepEqual(parseAddress('1F4-2B, 1BF-3,7B-3').map((l) => l.code), ['1F4-2B', '1BF-3', '7B-3']);
});

test('normalizes scanned codes', () => {
  assert.equal(normalizeCode('L:1c3-3c'), '1C3-3C');
  assert.equal(normalizeCode(' 6FB-1 '), '6FB-1');
});

test('rack-level labels match slots inside the rack', () => {
  assert.equal(rackOf('1C3-3C'), '1C3');
  assert.equal(rackOf('6A3'), '6A3');
  assert.ok(slotMatches('1C3-3C', '1C3-3C'));
  assert.ok(slotMatches('1C3', '1C3-3C'));
  assert.ok(!slotMatches('1C', '1C3-3C'));
  assert.ok(!slotMatches('1C3-3', '1C3-3C'));
  assert.ok(!slotMatches('6A', '6A3'));
});

test('replaces one location and leaves the rest as typed', () => {
  assert.equal(replaceLocation('1C3-3C,6A3', '1C3-3C', '2B1-1A'), '2B1-1A,6A3');
  assert.equal(replaceLocation('1D2-2A, 6FB-1', '6FB-1', '7A2'), '1D2-2A, 7A2');
  assert.equal(replaceLocation('PP12-5,PP13-4,1I4-1A, 1FF (Pdr) (5)', '1FF', '2FF'), 'PP12-5,PP13-4,1I4-1A, 2FF (Pdr) (5)');
  // moving onto a location it already has just removes the old one
  assert.equal(replaceLocation('1C3-3C,6A3', '1C3-3C', '6A3'), '6A3');
  // no old location -> add
  assert.equal(replaceLocation('1C3-3C', '', '6A3'), '1C3-3C,6A3');
  assert.equal(replaceLocation('', '', '6A3'), '6A3');
  // same place -> unchanged
  assert.equal(replaceLocation('1C3-3C,6A3', '6A3', '6A3'), '1C3-3C,6A3');
  assert.equal(replaceLocation('1B1-2.', '1B1-2', '1B2-1A'), '1B2-1A');
});

test('classifies scans', () => {
  const ctx = { skus: new Set(['220418004', '251205006']), codes: new Set(['1C3-3C', '6A3']), racks: new Set(['1C3', '6A3']) };
  assert.deepEqual(classifyScan('L:1C3-3C', ctx).kind, 'slot');
  assert.deepEqual(classifyScan('1c3-3c', ctx).code, '1C3-3C');
  assert.deepEqual(classifyScan('1C3', ctx).code, '1C3');
  assert.deepEqual(classifyScan('220418004', ctx).sku, '220418004');
  assert.deepEqual(classifyScan('S:220418004', ctx).sku, '220418004');
  assert.deepEqual(classifyScan('20648-251205006-100g-4-1', ctx).sku, '251205006');
  assert.deepEqual(classifyScan('hello', ctx).kind, 'unknown');
  assert.deepEqual(classifyScan('L:9Z9-9Z', ctx).kind, 'slot'); // printed labels always count as racks
});
