import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeoTransform, haversineMeters, distancePx } from '../src/utils/geo.js';

const world = { width: 1920, height: 1080, centerLat: 37.7749, centerLon: -122.4194, pixelsPerMeter: 10 };
const geo = createGeoTransform(world);

test('pixel <-> geo round trips inside the world bounds', () => {
  for (const [x, y] of [
    [0, 0],
    [960, 540],
    [1919.5, 1079.25],
    [12, 900],
  ]) {
    const [lon, lat] = geo.pixelToGeo(x, y);
    const back = geo.geoToPixel([lon, lat]);
    assert.ok(Math.abs(back.x - x) < 1e-6, `x drift ${back.x - x}`);
    assert.ok(Math.abs(back.y - y) < 1e-6, `y drift ${back.y - y}`);
  }
});

test('the world centre maps to the configured origin', () => {
  const [lon, lat] = geo.pixelToGeo(world.width / 2, world.height / 2);
  assert.ok(Math.abs(lon - world.centerLon) < 1e-12);
  assert.ok(Math.abs(lat - world.centerLat) < 1e-12);
});

test('y grows downward on screen but north on the globe', () => {
  const [, top] = geo.pixelToGeo(960, 0);
  const [, bottom] = geo.pixelToGeo(960, 1000);
  assert.ok(top > bottom, 'screen y=0 must be north of y=1000');
});

test('100 px of earshot is exactly 10 m of great-circle distance', () => {
  const a = geo.pixelToGeo(960, 540);
  const b = geo.pixelToGeo(1060, 540);
  const meters = haversineMeters(a, b);
  assert.ok(Math.abs(meters - 10) < 0.01, `expected ~10m, got ${meters}`);

  const diagonal = haversineMeters(geo.pixelToGeo(0, 0), geo.pixelToGeo(70, 70));
  assert.ok(Math.abs(diagonal - geo.pixelsToMeters(distancePx(0, 0, 70, 70))) < 0.01);
});

test('$maxDistance converts pixels to metres', () => {
  assert.equal(geo.maxDistanceMeters(100), 10);
  assert.equal(geo.pixelsToMeters(250), 25);
});

test('$centerSphere radius is expressed in radians of arc', () => {
  const radians = geo.radiansForPixels(100);
  assert.ok(Math.abs((radians * 6378138.1) - 10) < 1e-6);
  const sphere = geo.centerSphere(960, 540, 100);
  assert.equal(sphere.$centerSphere.length, 2);
  assert.ok(Math.abs(sphere.$centerSphere[0][0] - world.centerLon) < 1e-9);
});

test('GeoJSON points are well formed', () => {
  const point = geo.point(1800, 800); // east + south of the world centre (960, 540)
  assert.equal(point.type, 'Point');
  assert.equal(point.coordinates.length, 2);
  assert.ok(point.coordinates[0] > world.centerLon, 'east must be a larger longitude');
  assert.ok(point.coordinates[1] < world.centerLat, 'south must be a smaller latitude');
});