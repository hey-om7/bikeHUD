/**
 * Navigation Engine - generates route data and chunks for ESP32
 *
 * Uses Google Maps Directions API to get real routes.
 * Falls back to a mock route generator if no API key is configured.
 * Chunks route into small sections suitable for ESP32 memory constraints.
 */

import { Client } from '@googlemaps/google-maps-services-js';

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

export class NavigationEngine {
  constructor() {
    this.client = new Client({});
  }

  /**
   * Generate navigation route from source to destination
   * Returns chunked navigation data ready for ESP32 consumption
   */
  async generateRoute(sourceLat, sourceLng, destLat, destLng) {
    if (GOOGLE_MAPS_API_KEY) {
      try {
        return await this.generateGoogleRoute(sourceLat, sourceLng, destLat, destLng);
      } catch (e) {
        console.error('[NAV] Google Maps API error, falling back to mock:', e.message);
      }
    }

    // Fallback: generate mock route
    return this.generateMockRoute(sourceLat, sourceLng, destLat, destLng);
  }

  /**
   * Real Google Directions API route
   */
  async generateGoogleRoute(srcLat, srcLng, dstLat, dstLng) {
    const response = await this.client.directions({
      params: {
        origin: { lat: srcLat, lng: srcLng },
        destination: { lat: dstLat, lng: dstLng },
        mode: 'driving',
        key: GOOGLE_MAPS_API_KEY
      }
    });

    if (response.data.status !== 'OK' || !response.data.routes.length) {
      throw new Error(`Directions API returned: ${response.data.status}`);
    }

    const route = response.data.routes[0];
    const leg = route.legs[0];
    const steps = leg.steps;

    // Convert to compact chunks
    const chunks = steps.map((step, i) => {
      const maneuver = step.maneuver || 'straight';
      const direction = this.maneuverToDirection(maneuver);
      const bearing = this.calculateBearing(
        step.start_location.lat, step.start_location.lng,
        step.end_location.lat, step.end_location.lng
      );

      // Generate simple path offsets from polyline
      const pathOffsets = this.generatePathOffsets(step);

      return {
        instruction: this.cleanInstruction(step.html_instructions),
        direction,
        distance: step.distance.value,
        bearing: Math.round(bearing),
        path: pathOffsets
      };
    });

    return {
      chunks,
      summary: {
        distance: leg.distance.text,
        duration: leg.duration.text,
        startAddress: leg.start_address,
        endAddress: leg.end_address
      }
    };
  }

  /**
   * Mock route generator for development (no API key required)
   */
  generateMockRoute(srcLat, srcLng, dstLat, dstLng) {
    const distance = this.haversineDistance(srcLat, srcLng, dstLat, dstLng);
    const bearing = this.calculateBearing(srcLat, srcLng, dstLat, dstLng);

    // Generate 5-8 mock navigation steps
    const numSteps = Math.min(8, Math.max(5, Math.round(distance / 500)));
    const stepDistance = Math.round(distance / numSteps);

    const directions = ['S', 'R', 'S', 'L', 'S', 'R', 'S', 'S'];
    const instructions = [
      'Head north on Main Road',
      'Turn right onto Ring Road',
      'Continue straight',
      'Turn left onto MG Road',
      'Continue for 500m',
      'Turn right onto destination road',
      'Continue straight',
      'Arrive at destination'
    ];

    const chunks = [];
    for (let i = 0; i < numSteps; i++) {
      const progress = i / numSteps;
      const chunkBearing = (bearing + (i % 2 === 0 ? 0 : (i % 3 === 0 ? -90 : 90))) % 360;

      // Generate mock path offsets
      const path = [];
      for (let p = 0; p < 6; p++) {
        path.push(Math.round((p + 1) * (directions[i] === 'R' ? 3 : directions[i] === 'L' ? -3 : 0)));
        path.push(Math.round(-(p + 1) * 5));
      }

      chunks.push({
        instruction: instructions[i % instructions.length],
        direction: directions[i % directions.length],
        distance: stepDistance + Math.round(Math.random() * 200 - 100),
        bearing: Math.round(chunkBearing < 0 ? chunkBearing + 360 : chunkBearing),
        path
      });
    }

    // Mark last instruction
    chunks[chunks.length - 1].instruction = 'Arrive at destination';
    chunks[chunks.length - 1].direction = 'S';
    chunks[chunks.length - 1].distance = 50;

    return {
      chunks,
      summary: {
        distance: distance > 1000 ? `${(distance / 1000).toFixed(1)} km` : `${Math.round(distance)} m`,
        duration: `${Math.round(distance / 500)} min`,
        startAddress: `${srcLat.toFixed(4)}, ${srcLng.toFixed(4)}`,
        endAddress: `${dstLat.toFixed(4)}, ${dstLng.toFixed(4)}`
      }
    };
  }

  // ===== Utilities =====

  maneuverToDirection(maneuver) {
    if (maneuver.includes('right')) return 'R';
    if (maneuver.includes('left')) return 'L';
    if (maneuver.includes('uturn') || maneuver.includes('u-turn')) return 'U';
    return 'S';
  }

  cleanInstruction(html) {
    // Strip HTML tags and truncate
    const text = html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ');
    return text.length > 30 ? text.substring(0, 28) + '..' : text;
  }

  generatePathOffsets(step) {
    // Simplified: generate offsets based on start/end position
    const dx = step.end_location.lng - step.start_location.lng;
    const dy = step.end_location.lat - step.start_location.lat;
    const offsets = [];
    for (let i = 1; i <= 6; i++) {
      offsets.push(Math.round(dx * i * 1000) % 127);
      offsets.push(Math.round(-dy * i * 1000) % 127);
    }
    return offsets;
  }

  haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // meters
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  calculateBearing(lat1, lon1, lat2, lon2) {
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const rlat1 = lat1 * Math.PI / 180;
    const rlat2 = lat2 * Math.PI / 180;
    const y = Math.sin(dLon) * Math.cos(rlat2);
    const x = Math.cos(rlat1) * Math.sin(rlat2) -
              Math.sin(rlat1) * Math.cos(rlat2) * Math.cos(dLon);
    let brng = Math.atan2(y, x) * 180 / Math.PI;
    return (brng + 360) % 360;
  }
}
