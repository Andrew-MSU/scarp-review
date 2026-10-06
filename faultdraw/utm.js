// WGS84 geographic (degrees) to UTM zone 11N metres.
// Transverse Mercator, central meridian -117°, k0 0.9996, false easting 500000,
// false northing 0 (northern hemisphere). Snyder / USGS working-manual series.
// Always zone 11N, even if the point sits outside the zone strip.

const A = 6378137;
const F = 1 / 298.257223563;
const K0 = 0.9996;
const E2 = F * (2 - F);
const EP2 = E2 / (1 - E2);
const E4 = E2 * E2;
const E6 = E4 * E2;
const LON0 = (-117 * Math.PI) / 180;

/**
 * @param {number} latDeg
 * @param {number} lonDeg
 * @returns {{easting:number, northing:number, zone:string}|null}
 */
export function wgs84ToUtm11N(latDeg, lonDeg) {
  if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) return null;
  const phi = (latDeg * Math.PI) / 180;
  const lam = (lonDeg * Math.PI) / 180;
  const sin = Math.sin(phi);
  const cos = Math.cos(phi);
  const tan = Math.tan(phi);
  const N = A / Math.sqrt(1 - E2 * sin * sin);
  const T = tan * tan;
  const C = EP2 * cos * cos;
  const AA = (lam - LON0) * cos;
  const M = A * (
    (1 - E2 / 4 - 3 * E4 / 64 - 5 * E6 / 256) * phi
    - (3 * E2 / 8 + 3 * E4 / 32 + 45 * E6 / 1024) * Math.sin(2 * phi)
    + (15 * E4 / 256 + 45 * E6 / 1024) * Math.sin(4 * phi)
    - (35 * E6 / 3072) * Math.sin(6 * phi)
  );
  const easting = K0 * N * (
    AA
    + (1 - T + C) * AA ** 3 / 6
    + (5 - 18 * T + T * T + 72 * C - 58 * EP2) * AA ** 5 / 120
  ) + 500000;
  const northing = K0 * (
    M + N * tan * (
      AA * AA / 2
      + (5 - T + 9 * C + 4 * C * C) * AA ** 4 / 24
      + (61 - 58 * T + T * T + 600 * C - 330 * EP2) * AA ** 6 / 720
    )
  );
  return { easting, northing, zone: '11N' };
}
