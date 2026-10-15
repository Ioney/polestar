'use strict';
// Regions: connected components over links, continent-wide. Built in two
// steps so tiles stay independent: each tile labels its own components
// (links and falls inside the tile, both ways; numbered in entry order, so a
// rebuild is identical), then the continent joins the components that links
// across tile borders connect (Regions, a union-find over every tile's
// components). Falls count as links: a region holds every surface reachable
// from any other one way or the other, so different regions are unreachable
// for certain; within one, the search decides.

const { TILE_CELLS, NO_LINK, NO_COMP, FLAG, DIRS } = require('./format');
const { fallTarget } = require('./links');

class UnionFind {
	constructor(n) {
		this.parent = new Uint32Array(n);
		for (let i = 0; i < n; i++) this.parent[i] = i;
	}

	find(a) {
		const p = this.parent;
		let r = a;
		while (p[r] !== r) r = p[r];
		while (p[a] !== r) {
			const nx = p[a];
			p[a] = r;
			a = nx;
		}
		return r;
	}

	union(a, b) {
		const ra = this.find(a);
		const rb = this.find(b);
		if (ra === rb) return;
		if (ra < rb) this.parent[rb] = ra;
		else this.parent[ra] = rb;
	}
}

// tile (with links) -> { comp: Uint32Array(n), nComp }
function localComponents(tile) {
	const { n, flags, links, first, fallFrom, fallTo } = tile;
	const uf = new UnionFind(n);
	for (let k = 0; k < TILE_CELLS * TILE_CELLS; k++) {
		const i = k & 255;
		const j = k >> 8;
		for (let s = first[k], e = first[k + 1]; s < e; s++) {
			for (let d = 0; d < 8; d++) {
				const b = links[s * 8 + d];
				if (b === NO_LINK) continue;
				const ni = i + DIRS[d][0];
				const nj = j + DIRS[d][1];
				if (ni < 0 || nj < 0 || ni >= TILE_CELLS || nj >= TILE_CELLS) continue;
				uf.union(s, first[nj * TILE_CELLS + ni] + (b & 31));
			}
		}
	}
	for (let f = 0; f < fallFrom.length; f++) {
		const s = fallFrom[f];
		const { di, dj, layer } = fallTarget(fallTo[f]);
		const k = columnOf(first, s);
		const ni = (k & 255) + di;
		const nj = (k >> 8) + dj;
		if (ni < 0 || nj < 0 || ni >= TILE_CELLS || nj >= TILE_CELLS) continue;
		uf.union(s, first[nj * TILE_CELLS + ni] + layer);
	}
	const comp = new Uint32Array(n).fill(NO_COMP);
	const ids = new Map();
	for (let s = 0; s < n; s++) {
		if (flags[s] & FLAG.BLOCKED) continue;
		const r = uf.find(s);
		let id = ids.get(r);
		if (id === undefined) {
			id = ids.size;
			ids.set(r, id);
		}
		comp[s] = id;
	}
	return { comp, nComp: ids.size };
}

// The column of entry s (binary search over first).
function columnOf(first, s) {
	let lo = 0;
	let hi = TILE_CELLS * TILE_CELLS - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (first[mid] <= s) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

// Continent regions: components of every tile at compBase offsets, joined by
// pairs [globalA, globalB] -> region per global component (numbered from 0 in
// component order).
function joinRegions(total, pairs) {
	const uf = new UnionFind(total);
	for (let p = 0; p < pairs.length; p += 2) uf.union(pairs[p], pairs[p + 1]);
	const region = new Uint32Array(total);
	const ids = new Map();
	for (let g = 0; g < total; g++) {
		const r = uf.find(g);
		let id = ids.get(r);
		if (id === undefined) {
			id = ids.size;
			ids.set(r, id);
		}
		region[g] = id;
	}
	return { region, count: ids.size };
}

module.exports = { localComponents, joinRegions, columnOf, UnionFind };
