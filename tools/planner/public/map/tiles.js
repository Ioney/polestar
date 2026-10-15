// Terrain pyramid and zone art (spec section 2 art, drawn by MapView).
//
// Terrain: per frame the level L = clamp(round(log2(native / screen px per
// yard)), 0, maxLevel) of every visible continent is wanted (+1 tile margin,
// its parent level and the pinned top level as placeholders). A tile not yet
// loaded is drawn from its finest loaded ancestor (sub-rect UVs) with any
// loaded children on top, so zooming never shows holes. Fetches run by
// priority (top level, parents, distance to the centre, margin last) and are
// aborted when a tile leaves the wanted set. Textures upload as BC1 when the
// GPU has WEBGL_compressed_texture_s3tc, else a worker pool decodes to RGBA
// (level 0; mips by generateMipmap). An LRU keeps ~256 (BC1) / 96 (RGBA).
//
// Zone art: zones/<id>.png over its live frame, at 0.85 opacity above
// ZONE_ART_ZOOM px/yd (fading in), smaller zones on top.
//
// Walkable: the navigation grid's Walkable layer, /nav/tile/<c>/<col>_<row>.png
// (one 256 x 256 image per ADT tile: a pixel per grid column) over the
// tile's square at 60% opacity from WALKABLE_ZOOM px/yd, only for the tiles
// the grid has; pixels stay crisp when zoomed in.

import { ADT, program } from './gl.js';

const NATIVE = 512 / ADT;   // px per yard of a level 0 tile
export const ZONE_ART_ZOOM = 0.08;

const QUAD_VS = `#version 300 es
uniform vec4 u_rect;
uniform vec4 u_uv;
uniform vec2 u_center;
uniform float u_zoom;
uniform vec2 u_px;
out vec2 v_uv;
void main() {
	vec2 k = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
	v_uv = mix(u_uv.xy, u_uv.zw, k);
	gl_Position = vec4((mix(u_rect.xy, u_rect.zw, k) - u_center) * u_zoom * u_px, 0.0, 1.0);
}`;
const QUAD_FS = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
uniform float u_alpha;
in vec2 v_uv;
out vec4 o;
void main() { o = texture(u_tex, v_uv) * u_alpha; }`;

// One textured rectangle in layout coordinates per draw.
export class Quad {
	constructor(gl) {
		this.gl = gl;
		this.p = program(gl, QUAD_VS, QUAD_FS);
		this.vao = gl.createVertexArray();
	}

	begin(f) {
		const gl = this.gl, u = this.p.u;
		gl.useProgram(this.p.prog);
		gl.bindVertexArray(this.vao);
		gl.uniform2f(u.u_center, f.cx, f.cy);
		gl.uniform1f(u.u_zoom, f.zoom);
		gl.uniform2f(u.u_px, 2 / f.W, -2 / f.H);
		gl.uniform1i(u.u_tex, 0);
		gl.activeTexture(gl.TEXTURE0);
	}

	draw(tex, x0, y0, x1, y1, u0 = 0, v0 = 0, u1 = 1, v1 = 1, alpha = 1) {
		const gl = this.gl, u = this.p.u;
		gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.uniform4f(u.u_rect, x0, y0, x1, y1);
		gl.uniform4f(u.u_uv, u0, v0, u1, v1);
		gl.uniform1f(u.u_alpha, alpha);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
	}

	end() { this.gl.bindVertexArray(null); }

	dispose() { this.gl.deleteProgram(this.p.prog); this.gl.deleteVertexArray(this.vao); }
}

// aniso: { ext, max } (queried once: getParameter stalls on the GPU).
function anisotropy(gl) {
	const ext = gl.getExtension('EXT_texture_filter_anisotropic');
	return ext ? { ext, max: Math.min(8, gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT)) } : null;
}

function texParams(gl, aniso, mipmapped) {
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mipmapped ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.ext.TEXTURE_MAX_ANISOTROPY_EXT, aniso.max);
}

// d: [tex, x0, y0, x1, y1, u0, v0, u1, v1, bx0, by0, bx1, by1]: clip the rect to
// the bounds, the UVs with it; drops the bounds. False when nothing is left.
function clip(d) {
	const [, x0, y0, x1, y1, u0, v0, u1, v1, bx0, by0, bx1, by1] = d;
	const cx0 = Math.max(x0, bx0), cx1 = Math.min(x1, bx1), cy0 = Math.max(y0, by0), cy1 = Math.min(y1, by1);
	d.length = 9;
	if (cx0 >= cx1 || cy0 >= cy1) return false;
	if (cx0 === x0 && cx1 === x1 && cy0 === y0 && cy1 === y1) return true;
	const su = (u1 - u0) / (x1 - x0), sv = (v1 - v0) / (y1 - y0);
	d[1] = cx0; d[2] = cy0; d[3] = cx1; d[4] = cy1;
	d[5] = u0 + (cx0 - x0) * su; d[7] = u0 + (cx1 - x0) * su;
	d[6] = v0 + (cy0 - y0) * sv; d[8] = v0 + (cy1 - y0) * sv;
	return true;
}

async function gunzipIfNeeded(buf) {
	const b = new Uint8Array(buf, 0, 2);
	if (b[0] !== 0x1f || b[1] !== 0x8b) return buf;
	const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
	return new Response(stream).arrayBuffer();
}

// Workers decoding BC1 to RGBA, round robin.
class DecoderPool {
	constructor(n) {
		this.workers = [];
		this.jobs = new Map();
		this.next = 0;
		this.seq = 0;
		for (let i = 0; i < n; i++) {
			const w = new Worker(new URL('./bc1-worker.js', import.meta.url));
			w.onmessage = (e) => {
				const job = this.jobs.get(e.data.id);
				if (!job) return;
				this.jobs.delete(e.data.id);
				if (e.data.error) job.reject(new Error(e.data.error));
				else job.resolve(e.data.rgba);
			};
			this.workers.push(w);
		}
	}

	decode(buf, w, h) {
		const id = ++this.seq;
		return new Promise((resolve, reject) => {
			this.jobs.set(id, { resolve, reject });
			this.workers[this.next++ % this.workers.length].postMessage({ id, buf, w, h }, [buf]);
		});
	}

	dispose() { for (const w of this.workers) w.terminate(); }
}

export class Terrain {
	// index: art index.json; onChange(): a tile arrived (render again).
	constructor(gl, { artBase, index, compressed = null, onChange }) {
		this.gl = gl;
		this.base = artBase;
		this.index = index;
		this.onChange = onChange;
		this.s3tc = compressed === false ? null : gl.getExtension('WEBGL_compressed_texture_s3tc');
		this.aniso = anisotropy(gl);
		this.path = this.s3tc ? 's3tc' : 'worker';
		this.pool = this.s3tc ? null : new DecoderPool(Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) >> 1)));
		this.px = index.tile?.px || 512;
		this.mips = index.tile?.mips || 8;
		this.capacity = this.s3tc ? 256 : 96;
		this.maxInflight = 8;
		this.inflight = 0;
		this.tiles = new Map();     // key -> { key, c, L, tx, ty, status, tex, ctrl, used, data }
		this.uploads = [];
		this.frame = 0;
		this.ready = 0;
		this.exist = {};            // c -> [Set(tx * 4096 + ty) per level]
		for (const [c, ci] of Object.entries(index.continents || {})) {
			this.exist[c] = [];
			for (const [L, list] of Object.entries(ci.levels || {})) this.exist[c][+L] = new Set(list.map(([x, y]) => x * 4096 + y));
		}
	}

	levelFor(c, zoom, dpr) {
		const ci = this.index.continents?.[c];
		if (!ci) return 0;
		return Math.max(0, Math.min(ci.maxLevel, Math.round(Math.log2(NATIVE / (zoom * dpr)))));
	}

	_has(c, L, tx, ty) { return !!this.exist[c]?.[L]?.has(tx * 4096 + ty); }

	_get(c, L, tx, ty) {
		const t = this.tiles.get(`${c}/${L}/${tx}_${ty}`);
		return t && t.status === 'ready' ? t : null;
	}

	// f: { cx, cy, zoom, dpr, W, H, x0, y0, x1, y1 (layout view rect), conts: [{ c, ox, oy }] }.
	// Returns true while loads or uploads are pending.
	draw(f, quad) {
		const gl = this.gl;
		const frame = ++this.frame;
		const t0 = performance.now();
		this._upload(t0);
		const want = [];
		const below = [], above = [];
		for (const { c, ox, oy } of f.conts) {
			const ci = this.index.continents?.[c];
			if (!ci) continue;
			// coarse tiles span far beyond a small map: clip to its blocks (world mode packs maps close)
			const b = ci.bounds, n0 = below.length, a0 = above.length;
			const bx0 = (b.minCol - 32) * ADT + ox, bx1 = (b.maxCol - 31) * ADT + ox;
			const by0 = (b.minRow - 32) * ADT + oy, by1 = (b.maxRow - 31) * ADT + oy;
			const maxL = ci.maxLevel;
			const L = this.levelFor(c, f.zoom, f.dpr);
			const span = 2 ** L, n = 64 / span;
			const x0 = (f.x0 - ox) / ADT + 32, x1 = (f.x1 - ox) / ADT + 32;
			const y0 = (f.y0 - oy) / ADT + 32, y1 = (f.y1 - oy) / ADT + 32;
			if (x1 < 0 || y1 < 0 || x0 > 64 || y0 > 64) continue;
			const tx0 = Math.max(0, Math.floor(x0 / span)), tx1 = Math.min(n - 1, Math.floor(x1 / span));
			const ty0 = Math.max(0, Math.floor(y0 / span)), ty1 = Math.min(n - 1, Math.floor(y1 / span));
			const mx = (x0 + x1) / 2 / span, my = (y0 + y1) / 2 / span;
			for (const [tx, ty] of ci.levels?.[maxL] || []) want.push({ c, L: maxL, tx, ty, prio: -2e6 });
			if (L + 1 < maxL) {
				for (let ty = ty0 >> 1; ty <= ty1 >> 1; ty++) for (let tx = tx0 >> 1; tx <= tx1 >> 1; tx++) {
					if (this._has(c, L + 1, tx, ty)) want.push({ c, L: L + 1, tx, ty, prio: -1e6 + Math.hypot(tx * 2 + 1 - mx, ty * 2 + 1 - my) });
				}
			}
			for (let ty = Math.max(0, ty0 - 1); ty <= Math.min(n - 1, ty1 + 1); ty++) {
				for (let tx = Math.max(0, tx0 - 1); tx <= Math.min(n - 1, tx1 + 1); tx++) {
					if (!this._has(c, L, tx, ty)) continue;
					const margin = tx < tx0 || tx > tx1 || ty < ty0 || ty > ty1;
					want.push({ c, L, tx, ty, prio: (margin ? 1e6 : 0) + Math.hypot(tx + 0.5 - mx, ty + 0.5 - my) });
					if (margin) continue;
					const rx0 = (tx * span - 32) * ADT + ox, rx1 = ((tx + 1) * span - 32) * ADT + ox;
					const ry0 = (ty * span - 32) * ADT + oy, ry1 = ((ty + 1) * span - 32) * ADT + oy;
					const own = this._get(c, L, tx, ty);
					if (own) {
						own.used = frame;
						above.push([own.tex, rx0, ry0, rx1, ry1, 0, 0, 1, 1]);
						continue;
					}
					for (let k = 1; L + k <= maxL; k++) {
						const a = this._get(c, L + k, tx >> k, ty >> k);
						if (!a) continue;
						a.used = frame;
						const m = 2 ** k, fx = tx - ((tx >> k) << k), fy = ty - ((ty >> k) << k);
						below.push([a.tex, rx0, ry0, rx1, ry1, fx / m, fy / m, (fx + 1) / m, (fy + 1) / m]);
						break;
					}
					if (L > 0) {
						const half = span / 2;
						for (let j = 0; j < 4; j++) {
							const cx = tx * 2 + (j & 1), cy = ty * 2 + (j >> 1);
							const ch = this._get(c, L - 1, cx, cy);
							if (!ch) continue;
							ch.used = frame;
							above.push([ch.tex, (cx * half - 32) * ADT + ox, (cy * half - 32) * ADT + oy,
								((cx + 1) * half - 32) * ADT + ox, ((cy + 1) * half - 32) * ADT + oy, 0, 0, 1, 1]);
						}
					}
				}
			}
			for (let i = n0; i < below.length; i++) below[i].push(bx0, by0, bx1, by1);
			for (let i = a0; i < above.length; i++) above[i].push(bx0, by0, bx1, by1);
		}
		gl.disable(gl.BLEND);
		quad.begin(f);
		for (const d of below) if (clip(d)) quad.draw(...d);
		for (const d of above) if (clip(d)) quad.draw(...d);
		quad.end();
		this._pump(want);
		this._evict(frame);
		return this.uploads.length > 0 || this.inflight > 0;
	}

	_pump(want) {
		want.sort((a, b) => a.prio - b.prio);
		// Every wanted tile that is loaded counts as used this frame (border
		// tiles and placeholders too, drawn or not): eviction never takes a
		// tile the view wants, or it would be refetched the next frame.
		const wanted = new Set();
		for (const w of want) {
			wanted.add(w.key = `${w.c}/${w.L}/${w.tx}_${w.ty}`);
			const t = this.tiles.get(w.key);
			if (t && t.status === 'ready') t.used = this.frame;
		}
		for (const t of this.tiles.values()) {
			if (t.status === 'loading' && !wanted.has(t.key)) {
				t.ctrl.abort();
				this.tiles.delete(t.key);
			}
		}
		const now = performance.now();
		for (const w of want) {
			if (this.inflight >= this.maxInflight) break;
			const t = this.tiles.get(w.key);
			if (t && !(t.status === 'failed' && now - t.failedAt > 15000)) continue;
			this._fetch({ key: w.key, c: w.c, L: w.L, tx: w.tx, ty: w.ty, status: 'loading', tex: null, used: this.frame });
		}
	}

	async _fetch(t) {
		this.tiles.set(t.key, t);
		t.ctrl = new AbortController();
		this.inflight++;
		try {
			const res = await fetch(`${this.base}/tiles/${t.c}/${t.L}/${t.tx}_${t.ty}.bc1`, { signal: t.ctrl.signal });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const buf = await gunzipIfNeeded(await res.arrayBuffer());
			const need = (this.px / 4) ** 2 * 8;
			if (buf.byteLength < need) throw new Error(`short tile ${buf.byteLength}`);
			if (this.tiles.get(t.key) !== t) return;
			t.status = 'decoding';
			if (this.s3tc) t.data = buf;
			else t.rgba = await this.pool.decode(buf, this.px, this.px);
			if (this.tiles.get(t.key) !== t) return;
			this.uploads.push(t);
		} catch (err) {
			if (t.ctrl.signal.aborted) return;
			t.status = 'failed';
			t.failedAt = performance.now();
		} finally {
			this.inflight--;
			t.ctrl = null;
			this.onChange();
		}
	}

	// Upload within a ~3 ms budget per frame (at least one tile).
	_upload(t0) {
		const gl = this.gl;
		while (this.uploads.length) {
			const t = this.uploads.shift();
			if (this.tiles.get(t.key) !== t) continue;
			const tex = gl.createTexture();
			gl.bindTexture(gl.TEXTURE_2D, tex);
			gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
			if (this.s3tc) {
				const fmt = this.s3tc.COMPRESSED_RGB_S3TC_DXT1_EXT;
				let off = 0, levels = 0;
				for (let lvl = 0; lvl < this.mips; lvl++) {
					const s = this.px >> lvl;
					if (s < 4) break;
					const n = (s / 4) ** 2 * 8;
					if (off + n > t.data.byteLength) break;
					gl.compressedTexImage2D(gl.TEXTURE_2D, lvl, fmt, s, s, 0, new Uint8Array(t.data, off, n));
					off += n;
					levels++;
				}
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, levels - 1);
				texParams(gl, this.aniso, levels > 1);
				t.data = null;
			} else {
				gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.px, this.px, 0, gl.RGBA, gl.UNSIGNED_BYTE, t.rgba);
				gl.generateMipmap(gl.TEXTURE_2D);
				texParams(gl, this.aniso, true);
				t.rgba = null;
			}
			t.tex = tex;
			t.status = 'ready';
			this.ready++;
			if (performance.now() - t0 > 3) break;
		}
	}

	_evict(frame) {
		if (this.ready <= this.capacity) return;
		const ready = [...this.tiles.values()].filter((t) => t.status === 'ready' && t.used !== frame
			&& t.L !== this.index.continents[t.c].maxLevel);
		ready.sort((a, b) => a.used - b.used);
		for (const t of ready) {
			if (this.ready <= this.capacity) break;
			this.gl.deleteTexture(t.tex);
			this.tiles.delete(t.key);
			this.ready--;
		}
	}

	dispose() {
		for (const t of this.tiles.values()) {
			if (t.ctrl) t.ctrl.abort();
			if (t.tex) this.gl.deleteTexture(t.tex);
		}
		this.tiles.clear();
		this.uploads.length = 0;
		this.ready = 0;
		this.pool?.dispose();
	}
}

export class ZoneArt {
	constructor(gl, { artBase, index, onChange }) {
		this.gl = gl;
		this.base = artBase;
		this.onChange = onChange;
		this.aniso = anisotropy(gl);
		this.zones = Object.entries(index.zones || {}).map(([id, z]) => ({
			id, c: String(z.c), file: z.file, name: z.name,
			x0: -z.frame.left, x1: -z.frame.right, y0: -z.frame.top, y1: -z.frame.bottom,
			area: (z.frame.left - z.frame.right) * (z.frame.top - z.frame.bottom),
		})).sort((a, b) => b.area - a.area);
		this.tex = new Map();    // id -> { status, tex, used }
		this.loading = 0;
		this.capacity = 48;
		this.frame = 0;
	}

	alpha(zoom) { return 0.85 * Math.max(0, Math.min(1, (zoom - ZONE_ART_ZOOM * 0.75) / (ZONE_ART_ZOOM * 0.25))); }

	draw(f, quad) {
		const alpha = this.alpha(f.zoom);
		if (alpha <= 0) return false;
		const gl = this.gl;
		const frame = ++this.frame;
		const offs = new Map(f.conts.map((k) => [String(k.c), k]));
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
		quad.begin(f);
		let pending = false;
		// zones holding the view centre last, so the one looked at is whole
		const under = (z, o) => f.cx >= z.x0 + o.ox && f.cx <= z.x1 + o.ox && f.cy >= z.y0 + o.oy && f.cy <= z.y1 + o.oy;
		const order = [];
		for (const z of this.zones) if (offs.has(z.c) && !under(z, offs.get(z.c))) order.push(z);
		for (const z of this.zones) if (offs.has(z.c) && under(z, offs.get(z.c))) order.push(z);
		for (const z of order) {
			const o = offs.get(z.c);
			if (!o) continue;
			const x0 = z.x0 + o.ox, x1 = z.x1 + o.ox, y0 = z.y0 + o.oy, y1 = z.y1 + o.oy;
			if (x1 < f.x0 || x0 > f.x1 || y1 < f.y0 || y0 > f.y1) continue;
			const t = this.tex.get(z.id);
			if (t?.status === 'ready') {
				t.used = frame;
				quad.draw(t.tex, x0, y0, x1, y1, 0, 0, 1, 1, alpha);
			} else if ((!t || (t.status === 'failed' && performance.now() - t.failedAt > 15000)) && this.loading < 4) {
				this._load(z);
				pending = true;
			} else if (!t || t.status === 'loading') {
				pending = true;
			}
		}
		quad.end();
		this._evict(frame);
		return pending;
	}

	async _load(z) {
		const t = { status: 'loading', tex: null, used: this.frame };
		this.tex.set(z.id, t);
		this.loading++;
		try {
			const img = new Image();
			img.src = `${this.base}/${z.file}`;
			await img.decode();
			// disposed (context restored) or replaced while decoding: no texture
			if (this.tex.get(z.id) !== t) return;
			const gl = this.gl;
			t.tex = gl.createTexture();
			gl.bindTexture(gl.TEXTURE_2D, t.tex);
			gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
			gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
			gl.generateMipmap(gl.TEXTURE_2D);
			texParams(gl, this.aniso, true);
			t.status = 'ready';
		} catch {
			// retried after 15 s, as terrain tiles are
			t.status = 'failed';
			t.failedAt = performance.now();
		} finally {
			this.loading--;
			this.onChange();
		}
	}

	_evict(frame) {
		const ready = [...this.tex.entries()].filter(([, t]) => t.status === 'ready');
		if (ready.length <= this.capacity) return;
		ready.sort((a, b) => a[1].used - b[1].used);
		for (const [id, t] of ready.slice(0, ready.length - this.capacity)) {
			if (t.used === frame) break;
			this.gl.deleteTexture(t.tex);
			this.tex.delete(id);
		}
	}

	dispose() {
		for (const t of this.tex.values()) if (t.tex) this.gl.deleteTexture(t.tex);
		this.tex.clear();
	}
}

export const WALKABLE_ZOOM = 0.15;

export class WalkableTiles {
	// tiles: { [c]: ['col_row'] } (GET /nav/index.json)
	constructor(gl, { base = '/nav', tiles, onChange }) {
		this.gl = gl;
		this.base = base;
		this.onChange = onChange;
		this.have = new Map(Object.entries(tiles || {}).map(([c, list]) => [String(c), new Set(list)]));
		this.tex = new Map();    // `c/col_row` -> { status, tex, used }
		this.loading = 0;
		this.capacity = 200;
		this.frame = 0;
	}

	draw(f, quad) {
		if (f.zoom < WALKABLE_ZOOM) return false;
		const frame = ++this.frame;
		let pending = false;
		quad.begin(f);
		for (const o of f.conts) {
			const have = this.have.get(String(o.c));
			if (!have) continue;
			const c0 = Math.floor((f.x0 - o.ox) / ADT) + 32, c1 = Math.floor((f.x1 - o.ox) / ADT) + 32;
			const r0 = Math.floor((f.y0 - o.oy) / ADT) + 32, r1 = Math.floor((f.y1 - o.oy) / ADT) + 32;
			for (let row = Math.max(0, r0); row <= Math.min(63, r1); row++) {
				for (let col = Math.max(0, c0); col <= Math.min(63, c1); col++) {
					const key = `${col}_${row}`;
					if (!have.has(key)) continue;
					const id = `${o.c}/${key}`;
					const t = this.tex.get(id);
					if (t?.status === 'ready') {
						t.used = frame;
						const x0 = (col - 32) * ADT + o.ox, y0 = (row - 32) * ADT + o.oy;
						quad.draw(t.tex, x0, y0, x0 + ADT, y0 + ADT, 0, 0, 1, 1, 0.6);
					} else if (!t && this.loading < 6) {
						this._load(id);
						pending = true;
					} else if (!t || t.status === 'loading') pending = true;
				}
			}
		}
		quad.end();
		this._evict(frame);
		return pending;
	}

	async _load(id) {
		const t = { status: 'loading', tex: null, used: this.frame };
		this.tex.set(id, t);
		this.loading++;
		try {
			const img = new Image();
			img.src = `${this.base}/tile/${id}.png`;
			await img.decode();
			if (this.tex.get(id) !== t) return;
			const gl = this.gl;
			t.tex = gl.createTexture();
			gl.bindTexture(gl.TEXTURE_2D, t.tex);
			gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
			gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
			gl.generateMipmap(gl.TEXTURE_2D);
			texParams(gl, null, true);
			// one grid column per pixel: crisp cells when zoomed in
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
			t.status = 'ready';
		} catch {
			// a tile the server could not draw (a rebuild under way): kept failed, drawn as nothing
			t.status = 'failed';
		} finally {
			this.loading--;
			this.onChange();
		}
	}

	_evict(frame) {
		const ready = [...this.tex.entries()].filter(([, t]) => t.status === 'ready');
		if (ready.length <= this.capacity) return;
		ready.sort((a, b) => a[1].used - b[1].used);
		for (const [id, t] of ready.slice(0, ready.length - this.capacity)) {
			if (t.used === frame) break;
			this.gl.deleteTexture(t.tex);
			this.tex.delete(id);
		}
	}

	dispose() {
		for (const t of this.tex.values()) if (t.tex) this.gl.deleteTexture(t.tex);
		this.tex.clear();
	}
}
