// Vector layers on the GPU, all in layout coordinates (plane + the
// continent's offset) with screen-space sizes in CSS px:
// - Routes: one instanced quad per segment, expanded in the vertex shader to
//   the line width (round caps make round-ish joins), solid / dashed / dotted
//   in the fragment shader from the distance along the polyline; a casing
//   pass under the colour pass.
// - Circles: instanced quads with a circle SDF (fill, inner stroke, optional
//   dash along the circumference); areas draw through the stencil so the fill
//   blends once and only the outline of their union is stroked.
// - Markers: instanced quads sampling the pin atlas, optionally rotated.
// - Grid: the ADT grid over the whole screen.
// Colours arrive premultiplied.

import { Instances, program, ADT } from './gl.js';

const HEAD = `#version 300 es
precision highp float;
uniform vec2 u_center;
uniform float u_zoom;
uniform vec2 u_px;
uniform float u_dpr;
`;

// ---- routes ------------------------------------------------------------

const ROUTE_VS = `${HEAD}
layout(location = 0) in vec2 a_p0;
layout(location = 1) in vec2 a_p1;
layout(location = 2) in vec2 a_ds;
uniform vec4 u_color[32];
uniform vec4 u_style[32];
uniform vec4 u_cas[32];
uniform float u_casing;
out vec2 v_local;
out float v_d0;
flat out float v_len;
flat out vec4 v_color;
flat out vec4 v_st;
void main() {
	int s = int(a_ds.y + 0.5);
	vec4 st = u_style[s];
	float hw = st.x;
	vec4 col = u_color[s];
	if (u_casing > 0.5) {
		if (u_cas[s].a <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
		hw += u_cas[s].a;
		col = vec4(u_cas[s].rgb, 1.0);
	}
	vec2 s0 = (a_p0 - u_center) * u_zoom;
	vec2 s1 = (a_p1 - u_center) * u_zoom;
	vec2 d = s1 - s0;
	float len = length(d);
	vec2 dir = len > 1e-5 ? d / len : vec2(1.0, 0.0);
	vec2 nrm = vec2(-dir.y, dir.x);
	float pad = hw + 1.0;
	float k = float(gl_VertexID & 1), side = float(gl_VertexID >> 1) * 2.0 - 1.0;
	float along = mix(-pad, len + pad, k);
	v_local = vec2(along, side * pad);
	v_len = len;
	v_d0 = a_ds.x * u_zoom;
	v_color = col;
	v_st = vec4(hw, st.yzw);
	gl_Position = vec4((s0 + dir * along + nrm * side * pad) * u_px, 0.0, 1.0);
}`;

const ROUTE_FS = `${HEAD}
in vec2 v_local;
in float v_d0;
flat in float v_len;
flat in vec4 v_color;
flat in vec4 v_st;
out vec4 o;
void main() {
	float hw = v_st.x;
	float dist;
	float a = 1.0;
	if (v_st.w > 0.5) {
		float period = v_st.y;
		float pos = v_d0 + v_local.x;
		float c = (floor(pos / period) + 0.5) * period;
		float cl = c - v_d0;
		if (cl < 0.0 || cl > v_len) discard;
		dist = length(vec2(pos - c, v_local.y));
	} else {
		dist = length(vec2(v_local.x - clamp(v_local.x, 0.0, v_len), v_local.y));
		if (v_st.y > 0.0) {
			float m = mod(v_d0 + v_local.x, v_st.y + v_st.z);
			a = clamp(min(m, v_st.y - m) * u_dpr + 0.5, 0.0, 1.0);
		}
	}
	a *= clamp((hw - dist) * u_dpr + 0.5, 0.0, 1.0);
	if (a <= 0.0) discard;
	o = v_color * a;
}`;

export const MODE_NAMES = ['stand', 'walk', 'fight', 'fly', 'boat', 'teleport', 'ride', 'swim', 'fall', 'climb', 'lift', 'indoor'];
// The walk inside a kill or collect area (fight) is drawn thin and faint:
// it is the search between spawns, not a leg of the route. Routed walks
// (tools/lib/planner/timeline.js MODES): swim, climb, indoor (with an inner
// line, INNER) and falls (dots); a lift ride is drawn as a walk (its ends
// carry markers).
const GROUP = { stand: 0, walk: 0, ride: 0, lift: 0, fly: 1, boat: 2, fight: 3, swim: 4, climb: 5, indoor: 6, fall: 8 };
const INNER = 7;
const STATE = { past: 0, future: 1, current: 2 };

export class RouteLayer {
	constructor(gl) {
		this.gl = gl;
		this.p = program(gl, ROUTE_VS, ROUTE_FS);
		this.inst = new Instances(gl, [[0, 2], [1, 2], [2, 2]]);
		this.styles = null;
	}

	// col: { route, routePast, routeFuture, routeFly, routeBoat, routeSwim,
	// routeClimb, ink, shade } as [r, g, b, a] straight. Style rows per group
	// (walk, fly, boat, fight, swim, climb, indoor, its inner line, fall)
	// and state (past, future, current): the current leg in the accent (its
	// own colour for flights, boats, swims and climbs) over a shade casing,
	// the past faint and solid, the future dashed.
	setColors(col) {
		const color = [], style = [], cas = [];
		const pm = (c, a) => [c[0] * a, c[1] * a, c[2] * a, a];
		const shade = col.shade;
		const swim = col.routeSwim || col.routeBoat;
		const climb = col.routeClimb || col.route;
		const ink = col.ink || [1, 1, 1, 1];
		// [colour, alpha, half width, dash, gap, dotted, casing]
		const rows = [
			// walk
			[col.routePast, 0.4, 1.25, 0, 0, 0, 0],
			[col.routeFuture, 0.5, 1, 6, 5, 0, 0],
			[col.route, 1, 2.25, 0, 0, 0, 1.5],
			// fly: short dashes
			[col.routeFly, 0.4, 1.25, 4, 5, 0, 0],
			[col.routeFly, 0.75, 1.25, 4, 5, 0, 0],
			[col.routeFly, 1, 2, 5, 4, 0, 1.5],
			// boat: long dashes
			[col.routeBoat, 0.4, 1.5, 18, 6, 0, 0],
			[col.routeBoat, 0.75, 1.5, 18, 6, 0, 0],
			[col.routeBoat, 1, 2.25, 18, 6, 0, 1.5],
			// fight: the search between spawns, thin and faint
			[col.routePast, 0.22, 0.75, 0, 0, 0, 0],
			[col.routeFuture, 0.35, 0.75, 3, 4, 0, 0],
			[col.route, 0.6, 1, 0, 0, 0, 0],
			// swim: short dashes in NPC sky
			[swim, 0.4, 1.25, 3, 3, 0, 0],
			[swim, 0.7, 1.25, 3, 3, 0, 0],
			[swim, 1, 2, 3, 3, 0, 1.5],
			// climb: the walk's lines in place peach
			[climb, 0.4, 1.25, 0, 0, 0, 0],
			[climb, 0.6, 1, 6, 5, 0, 0],
			[climb, 1, 2.25, 0, 0, 0, 1.5],
			// indoor: the walk at 60% ...
			[col.routePast, 0.24, 1.25, 0, 0, 0, 0],
			[col.routeFuture, 0.3, 1, 6, 5, 0, 0],
			[col.route, 0.6, 2.25, 0, 0, 0, 1.5],
			// ... with a thin ink line inside
			[ink, 0.15, 0.4, 0, 0, 0, 0],
			[ink, 0.2, 0.4, 0, 0, 0, 0],
			[ink, 0.45, 0.5, 0, 0, 0, 0],
			// fall: a run of dots over the drop
			[col.routePast, 0.5, 1.25, 4, 0, 1, 0],
			[col.routeFuture, 0.7, 1.25, 4, 0, 1, 0],
			[col.route, 1, 1.75, 5, 0, 1, 1],
		];
		for (const [c, a, hw, dash, gap, dotted, casing] of rows) {
			color.push(...pm(c, a));
			style.push(hw, dash, gap, dotted);
			cas.push(shade[0], shade[1], shade[2], casing);
		}
		this.styles = { color: new Float32Array(color), style: new Float32Array(style), cas: new Float32Array(cas) };
	}

	// routes: [{ c, pts, mode, state }]; offsetOf(c) -> { ox, oy } | null;
	// tol: yards under which consecutive points are merged (sub-pixel detail
	// of long tracks at the current zoom; the last point is always kept).
	set(routes, offsetOf, tol = 0) {
		let n = 0;
		for (const r of routes) n += Math.max(0, (r.pts?.length || 0) / 2 - 1) * (r.mode === 'indoor' || r.mode === 11 ? 2 : 1);
		const data = new Float32Array(n * 6);
		let k = 0;
		for (const state of ['past', 'future', 'current']) {
			for (const r of routes) {
				if ((r.state || 'future') !== state) continue;
				const mode = typeof r.mode === 'number' ? MODE_NAMES[r.mode] : r.mode || 'walk';
				const g = GROUP[mode];
				if (g === undefined) continue;
				const off = offsetOf(r.c);
				if (!off) continue;
				const styles = mode === 'indoor' ? [g * 3 + STATE[state], INNER * 3 + STATE[state]] : [g * 3 + STATE[state]];
				for (const style of styles) {
					const p = r.pts, last = p.length - 2;
					let d = 0;
					let x0 = -p[1] + off.ox, y0 = -p[0] + off.oy;
					for (let i = 2; i <= last; i += 2) {
						const x1 = -p[i + 1] + off.ox, y1 = -p[i] + off.oy;
						const len = Math.hypot(x1 - x0, y1 - y0);
						// Falls are short: kept at any zoom.
						if (!(len > tol) && !(i === last && len > 1e-3) && mode !== 'fall') continue;
						data[k++] = x0; data[k++] = y0; data[k++] = x1; data[k++] = y1;
						data[k++] = d; data[k++] = style;
						d += len;
						x0 = x1;
						y0 = y1;
					}
				}
			}
		}
		this.inst.set(data, k / 6);
	}

	draw(f) {
		if (!this.inst.count) return;
		const gl = this.gl, u = this.p.u;
		gl.useProgram(this.p.prog);
		setCamera(gl, u, f);
		gl.uniform4fv(u.u_color, this.styles.color);
		gl.uniform4fv(u.u_style, this.styles.style);
		gl.uniform4fv(u.u_cas, this.styles.cas);
		gl.uniform1f(u.u_casing, 1);
		this.inst.draw();
		gl.uniform1f(u.u_casing, 0);
		this.inst.draw();
	}
}

function setCamera(gl, u, f) {
	gl.uniform2f(u.u_center, f.cx, f.cy);
	gl.uniform1f(u.u_zoom, f.zoom);
	gl.uniform2f(u.u_px, 2 / f.W, -2 / f.H);
	if (u.u_dpr) gl.uniform1f(u.u_dpr, f.dpr);
}

// ---- circles -----------------------------------------------------------

const CIRCLE_VS = `${HEAD}
layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec2 a_rad;
layout(location = 2) in vec4 a_fill;
layout(location = 3) in vec4 a_stroke;
layout(location = 4) in vec4 a_par;
out vec2 v_local;
flat out float v_R;
flat out vec4 v_fill;
flat out vec4 v_stroke;
flat out vec4 v_par;
void main() {
	float R = max(a_rad.x * u_zoom + a_rad.y, a_par.w);
	vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2.0 - 1.0;
	v_local = corner * (R + 1.5);
	v_R = R;
	v_fill = a_fill;
	v_stroke = a_stroke;
	v_par = a_par;
	gl_Position = vec4(((a_pos - u_center) * u_zoom + v_local) * u_px, 0.0, 1.0);
}`;

const CIRCLE_FS = `${HEAD}
uniform int u_part;
in vec2 v_local;
flat in float v_R;
flat in vec4 v_fill;
flat in vec4 v_stroke;
flat in vec4 v_par;
out vec4 o;
void main() {
	float d = length(v_local);
	float R = v_R, sw = min(v_par.x, R);
	if (u_part == 1) { if (d > R) discard; o = v_fill; return; }
	if (u_part == 2) { if (d > R - sw) discard; o = vec4(0.0); return; }
	float outer = clamp((R - d) * u_dpr + 0.5, 0.0, 1.0);
	float sa = sw > 0.0 ? outer * clamp((d - (R - sw)) * u_dpr + 0.5, 0.0, 1.0) : 0.0;
	if (v_par.y > 0.0 && sa > 0.0) {
		float C = 6.2831853 * max(R - sw * 0.5, 1.0);
		float period = v_par.y + v_par.z;
		float P = C / max(1.0, floor(C / period + 0.5));
		float dash = P * v_par.y / period;
		float m = mod((atan(v_local.y, v_local.x) + 3.14159265) / 6.2831853 * C, P);
		sa *= clamp(min(m, dash - m) * u_dpr + 0.5, 0.0, 1.0);
	}
	vec4 fill = u_part == 3 ? vec4(0.0) : v_fill * outer;
	o = v_stroke * sa + fill * (1.0 - v_stroke.a * sa);
	if (o.a <= 0.0) discard;
}`;

export const CIRCLE_STRIDE = 16;

// Write one circle instance at data[k]; returns k + CIRCLE_STRIDE.
// pos in layout coords; r yards + rpx CSS px (at least minPx); colours premultiplied.
export function circle(data, k, x, y, r, rpx, fill, stroke, sw = 0, dash = 0, gap = 0, minPx = 0) {
	data[k++] = x; data[k++] = y; data[k++] = r; data[k++] = rpx;
	data[k++] = fill[0]; data[k++] = fill[1]; data[k++] = fill[2]; data[k++] = fill[3];
	data[k++] = stroke[0]; data[k++] = stroke[1]; data[k++] = stroke[2]; data[k++] = stroke[3];
	data[k++] = sw; data[k++] = dash; data[k++] = gap; data[k++] = minPx;
	return k;
}

export class CircleProgram {
	constructor(gl) {
		this.gl = gl;
		this.p = program(gl, CIRCLE_VS, CIRCLE_FS);
	}

	instances() {
		return new Instances(this.gl, [[0, 2], [1, 2], [2, 4], [3, 4], [4, 4]]);
	}

	draw(f, inst, part = 0) {
		if (!inst.count) return;
		const gl = this.gl, u = this.p.u;
		gl.useProgram(this.p.prog);
		setCamera(gl, u, f);
		gl.uniform1i(u.u_part, part);
		inst.draw();
	}

	// Areas: fill the union once, stroke only its outline.
	drawUnion(f, inst) {
		if (!inst.count) return;
		const gl = this.gl;
		gl.enable(gl.STENCIL_TEST);
		gl.stencilFunc(gl.NOTEQUAL, 2, 2);
		gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
		gl.stencilMask(2);
		this.draw(f, inst, 1);
		gl.colorMask(false, false, false, false);
		gl.stencilFunc(gl.ALWAYS, 1, 1);
		gl.stencilMask(1);
		this.draw(f, inst, 2);
		gl.colorMask(true, true, true, true);
		gl.stencilFunc(gl.EQUAL, 0, 1);
		gl.stencilMask(0);
		this.draw(f, inst, 3);
		gl.stencilMask(0xff);
		gl.disable(gl.STENCIL_TEST);
	}
}

// ---- markers -----------------------------------------------------------

const MARKER_VS = `${HEAD}
layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec4 a_icon;
layout(location = 2) in float a_rot;
uniform vec2 u_grid;
out vec2 v_uv;
flat out float v_alpha;
flat out float v_done;
void main() {
	vec2 k = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
	float i = a_icon.x;
	vec2 cell = vec2(mod(i, u_grid.x), floor(i / u_grid.x));
	v_uv = (cell + k) / u_grid;
	v_alpha = a_icon.z;
	v_done = a_icon.w;
	vec2 off = (k - 0.5) * a_icon.y;
	float c = cos(a_rot), s = sin(a_rot);
	off = vec2(off.x * c - off.y * s, off.x * s + off.y * c);
	gl_Position = vec4(((a_pos - u_center) * u_zoom + off) * u_px, 0.0, 1.0);
}`;

const MARKER_FS = `${HEAD}
uniform sampler2D u_tex;
in vec2 v_uv;
flat in float v_alpha;
flat in float v_done;
out vec4 o;
void main() {
	vec4 c = texture(u_tex, v_uv);
	if (v_done > 0.5) c.rgb = mix(c.rgb, vec3(dot(c.rgb, vec3(0.3, 0.59, 0.11))), 0.75);
	o = c * v_alpha;
}`;

export class MarkerLayer {
	constructor(gl) {
		this.gl = gl;
		this.p = program(gl, MARKER_VS, MARKER_FS);
		this.inst = this.instances();
		this.atlas = null;
	}

	// [x, y, cell, size px, alpha, done, rotation rad] per marker.
	instances() {
		return new Instances(this.gl, [[0, 2], [1, 4], [2, 1]]);
	}

	draw(f, inst = this.inst) {
		if (!inst.count || !this.atlas) return;
		const gl = this.gl, u = this.p.u;
		gl.useProgram(this.p.prog);
		setCamera(gl, u, f);
		gl.uniform2f(u.u_grid, this.atlas.cols, this.atlas.rows);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this.atlas.tex);
		gl.uniform1i(u.u_tex, 0);
		inst.draw();
	}
}

// ---- grid --------------------------------------------------------------

const GRID_VS = `#version 300 es
void main() {
	vec2 p = vec2(float((gl_VertexID & 1) * 4 - 1), float((gl_VertexID >> 1) * 4 - 1));
	gl_Position = vec4(p, 0.0, 1.0);
}`;

const GRID_FS = `${HEAD}
uniform vec2 u_size;
out vec4 o;
float lines(vec2 P, float cell) {
	vec2 g = abs(fract(P / cell + 0.5) - 0.5) * cell * u_zoom;
	return 1.0 - clamp(min(g.x, g.y) * u_dpr - 0.25, 0.0, 1.0);
}
void main() {
	vec2 css = vec2(gl_FragCoord.x, u_size.y * u_dpr - gl_FragCoord.y) / u_dpr;
	vec2 P = u_center + (css - u_size * 0.5) / u_zoom;
	float fine = clamp((${ADT.toFixed(6)} * u_zoom - 6.0) / 10.0, 0.0, 1.0);
	float a = max(lines(P, ${ADT.toFixed(6)}) * 0.07 * fine, lines(P, ${(ADT * 8).toFixed(6)}) * 0.14);
	o = vec4(a, a, a, a);
}`;

export class GridLayer {
	constructor(gl) {
		this.gl = gl;
		this.p = program(gl, GRID_VS, GRID_FS);
		this.vao = gl.createVertexArray();
	}

	draw(f) {
		const gl = this.gl, u = this.p.u;
		gl.useProgram(this.p.prog);
		setCamera(gl, u, f);
		gl.uniform2f(u.u_size, f.W, f.H);
		gl.bindVertexArray(this.vao);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
		gl.bindVertexArray(null);
	}
}
