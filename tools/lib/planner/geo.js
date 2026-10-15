'use strict';
// The planner's coordinates (docs/ARCHITECTURE.md, "Route planner"):
// world { c, wx, wy } in yards (wx north, wy west, the client's convention),
// map percent { map, x, y, f } on a uiMapID in the Era frame (f 'e',
// map-frames.json `era`) or the live one (anything else, `forever`), and the
// renderer's plane X = -wy, Y = -wx (east right, north up). A map without a
// frame in the asked set uses the other set's.
//
// ADT tiles: tile (col, row) (the client's map<col>_<row>.blp) covers
// X in [(col - 32) * ADT, (col - 31) * ADT], Y in [(row - 32) * ADT, (row - 31) * ADT].

const { Frames } = require('../travel/geo');

const ADT = 1600 / 3;

// The ADT tile holding a world point.
function adtOf(wx, wy) {
	return { col: Math.floor(32 - wy / ADT), row: Math.floor(32 - wx / ADT) };
}

function toPlane(wx, wy) {
	return { X: -wy, Y: -wx };
}

const area = (b) => Math.abs((b.right - b.left) * (b.bottom - b.top));

class Geo {
	// mapFrames: map-frames.json ({ era, forever }); zones: zones.json
	constructor(mapFrames, zones) {
		this.zones = zones || {};
		this.era = new Frames((mapFrames && mapFrames.era) || {}, this.zones);
		this.live = new Frames((mapFrames && mapFrames.forever) || {}, this.zones);
		this.ids = [...new Set([...this.era.frames.keys(), ...this.live.frames.keys()])].sort((a, b) => a - b);
	}

	frame(map, f) {
		const [a, b] = f === 'e' ? [this.era, this.live] : [this.live, this.era];
		return a.frame(map) || b.frame(map);
	}

	toWorld(map, x, y, f) {
		const b = this.frame(map, f);
		if (!b) return null;
		return { c: b.c, wx: b.top + (b.bottom - b.top) * (y / 100), wy: b.left + (b.right - b.left) * (x / 100) };
	}

	toMap(map, c, wx, wy, f) {
		const b = this.frame(map, f);
		if (!b || b.c !== c) return null;
		return { x: ((wy - b.left) / (b.right - b.left)) * 100, y: ((wx - b.top) / (b.bottom - b.top)) * 100 };
	}

	// Zone/city maps (type 3) of continent c whose rectangle holds the point,
	// smallest first (a city wins over the zone around it).
	containing(c, wx, wy, f) {
		const out = [];
		for (const id of this.ids) {
			const z = this.zones[String(id)];
			if (z && z.type !== 3) continue;
			const b = this.frame(id, f);
			if (b.c !== c) continue;
			const p = this.toMap(id, c, wx, wy, f);
			if (p.x < 0 || p.x > 100 || p.y < 0 || p.y > 100) continue;
			out.push({ map: id, x: p.x, y: p.y, area: area(b) });
		}
		return out.sort((a, b) => a.area - b.area || a.map - b.map).map(({ map, x, y }) => ({ map, x, y }));
	}

	zoneName(map) {
		const z = this.zones[String(map)];
		return z && z.name ? String(z.name) : null;
	}

	continentOf(map) {
		const b = this.frame(map, 'l');
		return b ? b.c : null;
	}

	// The continent map of each c: the largest continent-type (2) map, else
	// (Forever's own instance maps, e.g. Zephras Isle) the largest map on it.
	continents() {
		const best = new Map();
		for (const id of this.ids) {
			const b = this.frame(id, 'l');
			const z = this.zones[String(id)];
			const rank = z && z.type === 2 ? 1 : 0;
			const cur = best.get(b.c);
			const a = area(b);
			if (!cur || rank > cur.rank || (rank === cur.rank && a > cur.area)) best.set(b.c, { map: id, rank, area: a });
		}
		return [...best.entries()].sort((a, b) => a[0] - b[0]).map(([c, v]) => ({ c, map: v.map, name: this.zoneName(v.map) || `Map ${c}` }));
	}
}

module.exports = { Geo, ADT, adtOf, toPlane };
