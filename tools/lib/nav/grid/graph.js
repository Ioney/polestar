'use strict';
// The abstract graph the route search runs over first (hierarchical A*, one
// level): nodes at tile borders, edges between a tile's nodes inside the
// tile, costed per reference profile (format.js REF_PROFILES), and the links
// across borders.
//
// Entrances: every link (or fall) between tiles T and N gives a pair (entry
// in T, entry in N). Pairs of one border group into runs (pairs whose ends
// are neighbouring columns on both sides at close heights), cut every
// RUN_MAX; a chunk's entrance is its middle pair crossing both ways (else the
// middle one-way pair of each direction), whose two entries are nodes of
// their tiles. Both tiles find the same pairs (each sees the
// other's border), order them the same way (by the tile first in (row, col)
// order) and so pick the same entrances without talking.
//
// tileGraph(around) works on one tile and its 3 x 3 neighbourhood (linked,
// with components); assembleGraph joins every tile's part into the
// continent's graph (format.js GRAPH) and its regions.

const { TILE_CELLS, FALL_SLIDE, RUN_MAX, REF_PROFILES, NO_COMP, NO_LINK, DIRS, FLAG, CLS, CODE_LIFT } = require('./format');
const { Space, MinHeap } = require('./search');
const { REFS, addLinkTerms, fallSeconds, liftSeconds } = require('../move');
const { joinRegions } = require('./regions');

const BAND = FALL_SLIDE + 1; // border columns whose links and falls may leave the tile
const TERM_SCALE = [4, 4, 4, 1, 10, 1, 10];

function quantise(terms) {
	return terms.map((v, i) => Math.min(65535, Math.round(v * TERM_SCALE[i])));
}

// Terms of one step: search outCode (stored link code, CLS.FALL or CODE_LIFT), flags, length, fall or lift height.
function stepTerms(out, code, fa, fb, d, h) {
	if (code === CLS.FALL) out[4] += fallSeconds(h, (fb & FLAG.SWIM) !== 0);
	else if (code === CODE_LIFT) out[6] += liftSeconds(h);
	else addLinkTerms(out, code, fa, fb, d);
}

function inBand(k) {
	const i = k & 255;
	const j = k >> 8;
	return i < BAND || j < BAND || i >= TILE_CELLS - BAND || j >= TILE_CELLS - BAND;
}

// Entries e (column k) and e2 (column k2) of one tile: the same, or linked
// either way as neighbours.
function joined(t, e, k, e2, k2) {
	if (e === e2) return true;
	const dx = (k2 & 255) - (k & 255);
	const dy = (k2 >> 8) - (k >> 8);
	if (Math.abs(dx) > 1 || Math.abs(dy) > 1) return false;
	for (let d = 0; d < 8; d++) {
		if (DIRS[d][0] !== dx || DIRS[d][1] !== dy) continue;
		const back = (d + 4) & 7;
		const a = t.links[e * 8 + d];
		const b = t.links[e2 * 8 + back];
		return (a !== NO_LINK && t.first[k2] + (a & 31) === e2) || (b !== NO_LINK && t.first[k] + (b & 31) === e);
	}
	return false;
}

// around: 3 x 3 linked tiles, index (drow + 1) * 3 + (dcol + 1), centre at 4.
// -> { col, row, nComp, nodes, nodeK, nodeZ, cross, intra: { [ref]: edges }, pairs }
function tileGraph(around, liftEntries = []) {
	const T = around[4];
	const order = [4, 0, 1, 2, 3, 5, 6, 7, 8].filter((x) => around[x]);
	const space = new Space(order.map((x) => around[x]));
	const offOf = (slot) => order[slot]; // around index of a slot
	const foot = REFS.foot;
	// Pairs per neighbour (around index): Map key `${eT},${eN}` -> pair.
	const borders = new Map();
	const addPair = (nIdx, eT, kT, eN, kN, dir, step) => {
		if (!borders.has(nIdx)) borders.set(nIdx, new Map());
		const m = borders.get(nIdx);
		const key = `${eT},${eN}`;
		let p = m.get(key);
		if (!p) {
			p = { eT, kT, eN, kN, dir: 0, step: null };
			m.set(key, p);
		}
		p.dir |= dir;
		if (step) p.step = step;
	};
	for (let slot = 0; slot < order.length; slot++) {
		const t = space.tiles[slot];
		const self = offOf(slot);
		for (let k = 0; k < TILE_CELLS * TILE_CELLS; k++) {
			if (!inBand(k)) continue;
			for (let e = t.first[k], end = t.first[k + 1]; e < end; e++) {
				if (t.flags[e] & FLAG.BLOCKED) continue;
				const cnt = space.expand(slot, e, k, foot);
				for (let x = 0; x < cnt; x++) {
					if (space.outCode[x] === CODE_LIFT) continue;
					const to = space.outTo[x];
					const s2 = space.slotOf(to);
					if (s2 === slot) continue;
					const other = offOf(s2);
					const v = to - space.base[s2];
					if (slot === 0) {
						addPair(other, e, k, v, space.outK[x], 1, { cls: space.outCode[x], d: space.outD[x], h: space.outH[x] });
					} else if (s2 === 0) {
						addPair(self, v, space.outK[x], e, k, 2, null);
					}
				}
			}
		}
	}
	const nodeSet = new Set();
	const reps = [];
	const pairs = new Set();
	for (const [nIdx, m] of borders) {
		const N = around[nIdx];
		const tFirst = T.row * 64 + T.col < N.row * 64 + N.col;
		const list = [...m.values()];
		for (const p of list) {
			const ct = T.comp[p.eT];
			const cn = N.comp[p.eN];
			if (ct !== NO_COMP && cn !== NO_COMP) pairs.add(`${ct},${nIdx},${cn}`);
		}
		// Canonical order: by the first tile's column, entry, then the other's.
		const P = (p) => (tFirst ? [p.kT, p.eT, p.kN, p.eN] : [p.kN, p.eN, p.kT, p.eT]);
		list.sort((a, b) => {
			const x = P(a);
			const y = P(b);
			return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || x[3] - y[3];
		});
		// Group: union-find over neighbouring pairs.
		const parent = list.map((_, i) => i);
		const find = (a) => {
			while (parent[a] !== a) {
				parent[a] = parent[parent[a]];
				a = parent[a];
			}
			return a;
		};
		const dc = (nIdx % 3) - 1;
		const dr = Math.floor(nIdx / 3) - 1;
		// Global column coordinates so both tiles compare the same way.
		const gT = (k) => [T.col * 256 + (k & 255), T.row * 256 + (k >> 8)];
		const gN = (k) => [(T.col + dc) * 256 + (k & 255), (T.row + dr) * 256 + (k >> 8)];
		const byCell = new Map();
		list.forEach((p, i) => {
			const [x, y] = gT(p.kT);
			const key = x * 100000 + y;
			if (!byCell.has(key)) byCell.set(key, []);
			byCell.get(key).push(i);
		});
		list.forEach((p, i) => {
			const [x, y] = gT(p.kT);
			const [nx, ny] = gN(p.kN);
			for (let ox = -1; ox <= 1; ox++) {
				for (let oy = -1; oy <= 1; oy++) {
					for (const q of byCell.get((x + ox) * 100000 + (y + oy)) || []) {
						if (q === i) continue;
						const o = list[q];
						const [mx, my] = gN(o.kN);
						if (Math.abs(mx - nx) > 1 || Math.abs(my - ny) > 1) continue;
						if (!joined(T, p.eT, p.kT, o.eT, o.kT) || !joined(N, p.eN, p.kN, o.eN, o.kN)) continue;
						const a = find(i);
						const b = find(q);
						if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
					}
				}
			}
		});
		const groups = new Map();
		list.forEach((p, i) => {
			const g = find(i);
			if (!groups.has(g)) groups.set(g, []);
			groups.get(g).push(p);
		});
		// Chunks of RUN_MAX columns (of the first tile's side); one entrance per
		// chunk: the middle pair crossing both ways, else the middle one-way
		// pair of each direction.
		const mid = (arr) => arr[(arr.length - 1) >> 1];
		for (const members of groups.values()) {
			const chunks = [];
			let cur = [];
			const cols = new Set();
			for (const p of members) {
				const pk = tFirst ? p.kT : p.kN;
				if (!cols.has(pk) && cols.size === RUN_MAX) {
					chunks.push(cur);
					cur = [];
					cols.clear();
				}
				cols.add(pk);
				cur.push(p);
			}
			if (cur.length) chunks.push(cur);
			for (const chunk of chunks) {
				const both = chunk.filter((p) => p.dir === 3);
				const picks = both.length ? [mid(both)] : [1, 2].map((d) => chunk.filter((p) => p.dir === d)).filter((a) => a.length).map(mid);
				for (const rep of picks) {
					nodeSet.add(rep.eT);
					reps.push({ nIdx, dc, dr, rep });
				}
			}
		}
	}
	// Lift ends are nodes too (their rides are edges of assembleGraph).
	for (const e of liftEntries) if (T.comp[e] !== NO_COMP) nodeSet.add(e);
	const nodes = [...nodeSet].sort((a, b) => a - b);
	const local = new Map(nodes.map((e, i) => [e, i]));
	const colOf = (e) => {
		let lo = 0;
		let hi = TILE_CELLS * TILE_CELLS - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (T.first[mid] <= e) lo = mid;
			else hi = mid - 1;
		}
		return lo;
	};
	const nodeK = nodes.map(colOf);
	const nodeZ = nodes.map((e) => T.z[e]);
	const cross = [];
	for (const { dc, dr, rep, nIdx } of reps) {
		if (!(rep.dir & 1)) continue;
		const N = around[nIdx];
		const terms = [0, 0, 0, 0, 0, 0, 0];
		stepTerms(terms, rep.step.cls, T.flags[rep.eT], N.flags[rep.eN], rep.step.d, rep.step.h);
		cross.push([local.get(rep.eT), dc, dr, rep.eN, ...quantise(terms)]);
	}
	// Intra-tile edges per reference profile: Dijkstra from every node over
	// the tile's links, gathered once (CSR) with their seconds per profile.
	const one = new Space([T]);
	const n = T.n;
	const off = new Uint32Array(n + 1);
	let eTo = new Int32Array(n * 4);
	let eCls = new Uint8Array(n * 4);
	let eD = new Float32Array(n * 4);
	let eH = new Float32Array(n * 4);
	const costs = REF_PROFILES.map(() => new Float32Array(n * 4));
	let m = 0;
	for (let k = 0; k < TILE_CELLS * TILE_CELLS; k++) {
		for (let e = T.first[k], end = T.first[k + 1]; e < end; e++) {
			off[e] = m;
			if (T.flags[e] & FLAG.BLOCKED) continue;
			for (let r = 0; r < REF_PROFILES.length; r++) {
				const cnt = one.expand(0, e, k, REFS[REF_PROFILES[r]]);
				if (m + cnt > eTo.length) {
					const cap = eTo.length * 2;
					const g = (Ctor, a) => {
						const b = new Ctor(cap);
						b.set(a);
						return b;
					};
					eTo = g(Int32Array, eTo);
					eCls = g(Uint8Array, eCls);
					eD = g(Float32Array, eD);
					eH = g(Float32Array, eH);
					for (let q = 0; q < costs.length; q++) costs[q] = g(Float32Array, costs[q]);
				}
				for (let x = 0; x < cnt; x++) {
					costs[r][m + x] = one.outCost[x];
					if (r) continue;
					eTo[m + x] = one.outTo[x];
					eCls[m + x] = one.outCode[x];
					eD[m + x] = one.outD[x];
					eH[m + x] = one.outH[x];
				}
				if (r === REF_PROFILES.length - 1) m += cnt;
			}
		}
	}
	off[n] = m;
	const eFrom = new Int32Array(m);
	for (let e = 0; e < n; e++) for (let x = off[e]; x < off[e + 1]; x++) eFrom[x] = e;
	const intra = {};
	const dist = new Float64Array(n);
	const pe = new Int32Array(n);
	const heap = new MinHeap(4096);
	const compNodes = new Map();
	for (const e of nodes) compNodes.set(T.comp[e], (compNodes.get(T.comp[e]) || 0) + 1);
	for (let r = 0; r < REF_PROFILES.length; r++) {
		const cost = costs[r];
		const edges = [];
		for (let a = 0; a < nodes.length; a++) {
			dist.fill(Infinity);
			const src = nodes[a];
			dist[src] = 0;
			pe[src] = -1;
			heap.size = 0;
			heap.push(0, src);
			let left = compNodes.get(T.comp[src]) - 1;
			while (heap.size && left > 0) {
				const u = heap.pop();
				const du = dist[u];
				if (heap.top > du) continue;
				if (u !== src && local.has(u)) left--;
				for (let x = off[u], end = off[u + 1]; x < end; x++) {
					const v = eTo[x];
					const nd = du + cost[x];
					if (nd < dist[v]) {
						dist[v] = nd;
						pe[v] = x;
						heap.push(nd, v);
					}
				}
			}
			for (let b = 0; b < nodes.length; b++) {
				if (b === a || dist[nodes[b]] === Infinity) continue;
				const terms = [0, 0, 0, 0, 0, 0, 0];
				for (let v = nodes[b]; v !== src; v = eFrom[pe[v]]) stepTerms(terms, eCls[pe[v]], T.flags[eFrom[pe[v]]], T.flags[v], eD[pe[v]], eH[pe[v]]);
				edges.push([a, b, ...quantise(terms)]);
			}
		}
		intra[REF_PROFILES[r]] = edges;
	}
	const pairList = [];
	for (const key of pairs) pairList.push(...key.split(',').map(Number));
	const compSize = new Array(T.nComp).fill(0);
	for (let e = 0; e < T.n; e++) if (T.comp[e] !== NO_COMP) compSize[T.comp[e]]++;
	const lifts = liftEntries.filter((e) => T.comp[e] !== NO_COMP).map((e) => [e, T.comp[e]]);
	return { col: T.col, row: T.row, nComp: T.nComp, compSize, nodes, nodeK, nodeZ, cross, intra, pairs: pairList, lifts };
}

// A tileGraph() part with its intra edges as typed arrays (in place):
// intra[ref] = { a: Uint16Array, b: Uint16Array, terms: Uint16Array(7 per edge) }.
// The build compacts each part as it reads it, so a continent's parts fit.
function compactPart(p) {
	for (const ref of REF_PROFILES) {
		const edges = p.intra[ref];
		if (!Array.isArray(edges)) continue;
		const a = new Uint16Array(edges.length);
		const b = new Uint16Array(edges.length);
		const terms = new Uint16Array(edges.length * 7);
		edges.forEach((ed, x) => {
			a[x] = ed[0];
			b[x] = ed[1];
			for (let q = 0; q < 7; q++) terms[x * 7 + q] = ed[2 + q];
		});
		p.intra[ref] = { a, b, terms };
	}
	return p;
}

// parts: every tile's tileGraph() of continent c; lifts: the continent's lifts
// (lifts.json) -> { graph (format.js GRAPH input), stats }
function assembleGraph(c, parts, lifts = []) {
	parts = [...parts].sort((a, b) => a.row - b.row || a.col - b.col);
	const at = new Map();
	let nodeBase = 0;
	let compBase = 0;
	const tiles = parts.map((p) => {
		const t = { col: p.col, row: p.row, nodeBase, nodeCount: p.nodes.length, compBase, compCount: p.nComp };
		at.set(p.col * 65536 + p.row, { t, local: new Map(p.nodes.map((e, i) => [e, i])) });
		nodeBase += p.nodes.length;
		compBase += p.nComp;
		return t;
	});
	const N = nodeBase;
	const nodeEntry = new Uint32Array(N);
	const nodeK = new Uint16Array(N);
	const nodeZ = new Float32Array(N);
	parts.forEach((p, i) => {
		nodeEntry.set(p.nodes, tiles[i].nodeBase);
		nodeK.set(p.nodeK, tiles[i].nodeBase);
		nodeZ.set(p.nodeZ, tiles[i].nodeBase);
	});
	let broken = 0;
	// Cross edges, resolved once: [from, to, terms...]
	const cross = [];
	parts.forEach((p, i) => {
		for (const [a, dc, dr, eN, ...terms] of p.cross) {
			const n = at.get((p.col + dc) * 65536 + (p.row + dr));
			const b = n && n.local.get(eN);
			if (b === undefined) {
				broken++;
				continue;
			}
			cross.push([tiles[i].nodeBase + a, n.t.nodeBase + b, terms]);
		}
	});
	// Lift rides, both ways: lifts [{ a, b, h }] with ends { col, row, entry }.
	const liftJoins = [];
	for (const L of lifts) {
		const ends = [L.a, L.b].map((x) => {
			const n = at.get(x.col * 65536 + x.row);
			const node = n && n.local.get(x.entry);
			const part = n && parts[tiles.indexOf(n.t)];
			const comp = part && (part.lifts || []).find(([e]) => e === x.entry);
			return node === undefined || !comp ? null : { node: n.t.nodeBase + node, comp: n.t.compBase + comp[1] };
		});
		if (!ends[0] || !ends[1]) continue;
		const terms = [0, 0, 0, 0, 0, 0, Math.min(65535, Math.round(liftSeconds(L.h) * TERM_SCALE[6]))];
		cross.push([ends[0].node, ends[1].node, terms], [ends[1].node, ends[0].node, terms]);
		liftJoins.push(ends[0].comp, ends[1].comp);
	}
	const graphs = REF_PROFILES.map((ref) => {
		const off = new Uint32Array(N + 1);
		parts.forEach((p, i) => {
			const base = tiles[i].nodeBase;
			const { a } = compactPart(p).intra[ref];
			for (let x = 0; x < a.length; x++) off[base + a[x] + 1]++;
		});
		for (const [a] of cross) off[a + 1]++;
		for (let v = 0; v < N; v++) off[v + 1] += off[v];
		const at2 = off.slice(0, N);
		const to = new Uint32Array(off[N]);
		const terms = new Uint16Array(off[N] * 7);
		parts.forEach((p, i) => {
			const base = tiles[i].nodeBase;
			const e = p.intra[ref];
			for (let x = 0; x < e.a.length; x++) {
				const y = at2[base + e.a[x]]++;
				to[y] = base + e.b[x];
				terms.set(e.terms.subarray(x * 7, x * 7 + 7), y * 7);
			}
		});
		for (const [a, b, tm] of cross) {
			const y = at2[a]++;
			to[y] = b;
			terms.set(tm, y * 7);
		}
		return { off, to, terms };
	});
	const joins = liftJoins;
	parts.forEach((p, i) => {
		for (let x = 0; x < p.pairs.length; x += 3) {
			const [ct, nIdx, cn] = [p.pairs[x], p.pairs[x + 1], p.pairs[x + 2]];
			const n = at.get((p.col + (nIdx % 3) - 1) * 65536 + (p.row + Math.floor(nIdx / 3) - 1));
			if (!n) continue;
			joins.push(tiles[i].compBase + ct, n.t.compBase + cn);
		}
	});
	const { region, count } = joinRegions(compBase, joins);
	// Walkable surfaces per region (snapping prefers big ones over pockets).
	const regionSize = new Uint32Array(count);
	parts.forEach((p, i) => {
		for (let x = 0; x < p.nComp; x++) regionSize[region[tiles[i].compBase + x]] += p.compSize[x];
	});
	return {
		graph: { c, tiles, nodeEntry, nodeK, nodeZ, region, regionSize, graphs },
		stats: { nodes: N, edges: graphs.map((g) => g.to.length), regions: count, components: compBase, broken },
	};
}

module.exports = { tileGraph, assembleGraph, compactPart, TERM_SCALE };
