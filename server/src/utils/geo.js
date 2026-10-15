/**
 * Tangent-plane geodetic helpers.
 *
 * The office is a flat 2D pixel plane (origin top-left, +y grows downward).
 * MongoDB geospatial indexes only understand GeoJSON lon/lat points, so the
 * pixel plane is mapped onto a tiny patch of the globe centred on the room.
 * Because the patch is ~200 m wide, a tangent-plane (equirectangular) mapping
 * is accurate to well under a centimetre — far beyond what the audio engine
 * needs, and it keeps every query index-friendly.
 *
 *   1 pixel === 1 / PIXELS_PER_METER metres
 *   => 100 px of "earshot" is exactly 10 m to MongoDB.
 */

export const EARTH_RADIUS_M = 6378138.1;
const DEG = Math.PI / 180;

export const distancePx = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);

/**
 * Build a reusable pixel <-> GeoJSON transform bound to one world definition.
 * @param {{width:number,height:number,centerLat:number,centerLon:number,pixelsPerMeter:number}} world
 */
export function createGeoTransform(world) {
  const { width, height, centerLat, centerLon, pixelsPerMeter } = world;
  const metersPerPixel = 1 / pixelsPerMeter;

  // Radians of longitude/latitude covered by one pixel at the room's latitude.
  const lonRadiansPerPixel = metersPerPixel / (EARTH_RADIUS_M * Math.cos(centerLat * DEG));
  const latRadiansPerPixel = metersPerPixel / EARTH_RADIUS_M;

  return {
    world,
    metersPerPixel,

    /** Pixel (x, y) -> GeoJSON [longitude, latitude]. */
    pixelToGeo(x, y) {
      return [
        centerLon + (x - width / 2) * lonRadiansPerPixel / DEG,
        centerLat - (y - height / 2) * latRadiansPerPixel / DEG,
      ];
    },

    /** GeoJSON [longitude, latitude] -> pixel {x, y}. */
    geoToPixel([lon, lat]) {
      return {
        x: (lon - centerLon) * DEG / lonRadiansPerPixel + width / 2,
        y: (centerLat - lat) * DEG / latRadiansPerPixel + height / 2,
      };
    },

    /** MongoDB GeoJSON point for a pixel coordinate. */
    point(x, y) {
      return { type: 'Point', coordinates: this.pixelToGeo(x, y) };
    },

    pixelsToMeters(px) {
      return px * metersPerPixel;
    },
    metersToPixels(m) {
      return m / metersPerPixel;
    },

    /** Radius (in radians) accepted by $geoWithin: { $centerSphere: [[lon, lat], radians] }. */
    radiansForPixels(px) {
      return (px * metersPerPixel) / EARTH_RADIUS_M;
    },

    /** Full $geoWithin / $near clause payload for a pixel centre + pixel radius. */
    centerSphere(x, y, px) {
      const [lon, lat] = this.pixelToGeo(x, y);
      return { $centerSphere: [[lon, lat], this.radiansForPixels(px)] };
    },

    /** $maxDistance for $near (metres on a 2dsphere index). */
    maxDistanceMeters(px) {
      return this.pixelsToMeters(px);
    },

    /** Great-circle distance (metres) — used to cross-check MongoDB results. */
    haversineMeters(aLonLat, bLonLat) {
      const dLat = (bLonLat[1] - aLonLat[1]) * DEG;
      const dLon = (bLonLat[0] - aLonLat[0]) * DEG;
      const la1 = aLonLat[1] * DEG;
      const la2 = bLonLat[1] * DEG;
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
      return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
    },
  };
}

/** Great-circle distance in metres between two GeoJSON points. */
export function haversineMeters(a, b) {
  const dLat = (b[1] - a[1]) * DEG;
  const dLon = (b[0] - a[0]) * DEG;
  const la1 = a[1] * DEG;
  const la2 = b[1] * DEG;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

