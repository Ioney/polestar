// What the page draws on the MapView: the route polylines (track split by
// continent, mode and step; past/current/future rebuilt on a step change
// only), the scene of the selected step, the character every frame, the
// edit handles, following and framing.
import { S } from './state.js';
import { position, goalAt, MODE_NAMES } from './playback.js';
import { verbMeta, goalIcon, pretty } from './dom.js';

const TELEPORT = 5;
const LIFT = 10;
const RING_VERBS = new Set(['goto', 'explore']);
const PAST_STEPS = 4;
const FUTURE_STEPS = 15;
// Below this zoom (CSS px per yard; a zone is about 3,000-8,000 yd wide)
// playing with Follow on zooms in to FOLLOW_ZOOM: ~2,000 yd across a 1,200 px map.
const FOLLOW_ZOOM_MIN = 0.12;
const FOLLOW_ZOOM = 0.6;

export function mapController(map) {
	let routes = [];
	let sceneKey = '';
	let routeStep = -2;
	let followHold = 0;
	let lastPos = null;
	let heading = 0;
	let legsKey = null;      // { tl, i }: the step legs() last built
	let legsOf = [];

	// Track segments (j-1 -> j) grouped into polylines; segment j belongs to
	// the step whose k0..k1 range reaches j first.
	function buildRoutes(tl) {
		const tr = tl.track;
		const out = [];
		let last = 0;
		for (const step of tl.steps) {
			if (step.k1 == null || step.k1 <= last) continue;
			let cur = null;
			for (let j = last + 1; j <= step.k1; j++) {
				const m = tr.m[j];
				const c = tr.c[j];
				if (m === TELEPORT || tr.c[j - 1] !== c) {
					cur = null;
					continue;
				}
				if (!cur || cur.m !== m) {
					cur = { c, m, pts: [tr.x[j - 1], tr.y[j - 1]] };
					out.push({ cur, step: step.i });
				}
				cur.pts.push(tr.x[j], tr.y[j]);
			}
			last = step.k1;
		}
		return out.map(({ cur, step }) => ({ c: cur.c, pts: new Float32Array(cur.pts), mode: MODE_NAMES[cur.m] || 'walk', step, state: 'future' }));
	}

	function sceneOf(i, t) {
		const step = S.timeline.steps[i];
		const areas = [];
		const dots = [];
		const markers = [];
		const rings = [];
		if (!step) return { areas, dots, markers, rings };
		const active = goalAt(i, t);
		for (const g of step.goals) {
			if (!g.applies || g.skip) continue;
			const meta = verbMeta(g.verb);
			for (const sp of g.spots || []) areas.push({ c: sp.c, wx: sp.wx, wy: sp.wy, r: sp.r, kind: g.verb, tint: meta.subj });
			if (g.spawns) {
				for (const [wx, wy] of g.spawns.pts || []) dots.push({ c: g.spawns.c, wx, wy, kind: g.spawns.kind, tint: meta.subj });
			}
			if (g.at) {
				markers.push({ c: g.at.c, wx: g.at.wx, wy: g.at.wy, icon: goalIcon(g, S.character), glyph: meta.glyph, tint: meta.subj, label: pretty(g.label), active: g === active, done: g.end <= t, step: i });
				if (RING_VERBS.has(g.verb) && g.r) rings.push({ c: g.at.c, wx: g.at.wx, wy: g.at.wy, r: g.r });
			}
		}
		// Lift rides on the step's routed walks: the lift glyph at both ends.
		const tr = S.timeline.track;
		for (let j = Math.max(1, step.k0 || 0); j <= step.k1 && j < tr.m.length; j++) {
			if (tr.m[j] !== LIFT) continue;
			for (const k of [j - 1, j]) markers.push({ c: tr.c[k], wx: tr.x[k], wy: tr.y[k], icon: null, glyph: 'lift', tint: 'place', label: 'Lift', step: i });
		}
		return { areas, dots, markers, rings };
	}

	return {
		setTimeline(tl) {
			routes = tl ? buildRoutes(tl) : [];
			routeStep = -2;
			sceneKey = '';
			map.setRoute([]);
			map.setScene({ areas: [], dots: [], markers: [], rings: [] });
			if (!tl) map.setCharacter(null);
		},

		// Route states for the selected step (only when it changed): by
		// S.extent the stretch around it (so a 60-level route does not cover
		// the map while playing), its guide, or the whole route (bird's-eye).
		setStep(i, force = false) {
			if (i === routeStep && !force) return;
			routeStep = i;
			const tl = S.timeline;
			let lo = i - PAST_STEPS;
			let hi = i + FUTURE_STEPS;
			if (S.extent === 'route') {
				lo = -Infinity;
				hi = Infinity;
			} else if (S.extent === 'guide' && tl && tl.steps[i]) {
				const g = tl.guides[tl.steps[i].gi];
				lo = g.s0;
				hi = g.s1;
			}
			const shown = [];
			for (const r of routes) {
				if (r.step < lo || r.step > hi) continue;
				r.state = r.step < i ? 'past' : r.step === i ? 'current' : 'future';
				shown.push(r);
			}
			map.setRoute(shown);
			sceneKey = '';
		},

		// Per animation frame: the character, the scene's active goal, following.
		frame(t, i, { follow }) {
			if (!S.timeline) return;
			const pos = position(t);
			lastPos = pos;
			// Heading: toward where the character is a moment later (kept while it stands).
			const ahead = pos ? position(t + 3) : null;
			if (pos && ahead && ahead.c === pos.c) {
				const dx = -(ahead.wy - pos.wy), dy = -(ahead.wx - pos.wx);
				if (Math.hypot(dx, dy) > 0.5) heading = Math.atan2(dx, -dy);
			}
			map.setCharacter(pos ? { c: pos.c, wx: pos.wx, wy: pos.wy, heading } : null);
			const active = goalAt(i, t);
			const step = S.timeline.steps[i];
			const done = step ? step.goals.reduce((n, g) => n + (g.end <= t ? 1 : 0), 0) : 0;
			const key = `${i}|${active ? active.line : ''}|${done}`;
			if (key !== sceneKey) {
				sceneKey = key;
				map.setScene(sceneOf(i, t));
			}
			if (follow && pos) this.follow(pos);
		},

		// Keeps the character in the middle 60% of the view; switches continent.
		follow(pos) {
			const now = performance.now();
			if (now < followHold) return;
			const v = map.view;
			if (!v) return;
			if (v.mode === 'continent' && v.c !== pos.c) {
				map.setView({ c: pos.c, wx: pos.wx, wy: pos.wy }, { animate: false });
				followHold = now + 300;
				return;
			}
			const sp = map.toScreen(pos.c, pos.wx, pos.wy);
			const canvas = map.canvas || document.getElementById('map');
			const w = canvas.clientWidth;
			const hh = canvas.clientHeight;
			if (!sp) return;
			if (sp.x < w * 0.2 || sp.x > w * 0.8 || sp.y < hh * 0.2 || sp.y > hh * 0.8) {
				map.setView({ c: pos.c, wx: pos.wx, wy: pos.wy }, { animate: true });
				followHold = now + 700;
			}
		},

		// Starting to play while following from a continent or world view:
		// zoom in on the character (once, so zooming out later is kept).
		closeIn() {
			const v = map.view;
			const pos = lastPos || position(S.t);
			if (!v || !pos || v.zoom >= FOLLOW_ZOOM_MIN) return;
			if (v.mode === 'world') map.setMode('continent');
			map.setView({ c: pos.c, wx: pos.wx, wy: pos.wy, zoom: FOLLOW_ZOOM }, { animate: true });
			followHold = performance.now() + 700;
		},

		// Frames every located goal of step i and the character.
		fitStep(i, t) {
			const step = S.timeline && S.timeline.steps[i];
			if (!step) return;
			const byC = new Map();
			const add = (c, wx, wy) => {
				if (!byC.has(c)) byC.set(c, []);
				byC.get(c).push([wx, wy]);
			};
			for (const g of step.goals) {
				if (!g.applies || g.skip) continue;
				if (g.at) add(g.at.c, g.at.wx, g.at.wy);
				for (const sp of g.spots || []) add(sp.c, sp.wx + (sp.r || 0), sp.wy + (sp.r || 0)), add(sp.c, sp.wx - (sp.r || 0), sp.wy - (sp.r || 0));
			}
			const pos = position(t != null ? t : step.start);
			let c = pos ? pos.c : null;
			if (!byC.size && !pos) return;
			if (byC.size && !byC.has(c)) c = [...byC.keys()][0];
			const pts = [...(byC.get(c) || [])];
			if (pos && pos.c === c) pts.push([pos.wx, pos.wy]);
			followHold = performance.now() + 900;
			map.fitWorld(c, pts, { padding: 70, animate: true, maxZoom: 1.1 });
		},

		// Edit handles for the GuideView step `vstep` (every located goal).
		setHandles(vstep) {
			if (!vstep) {
				map.setHandles([]);
				return;
			}
			const out = [];
			for (const g of vstep.goals) {
				if (!g.world) continue;
				const r = RING_VERBS.has(g.verb) ? (g.compiled && g.compiled.r != null ? g.compiled.r : g.fields && g.fields.r != null ? g.fields.r : null) : null;
				out.push({ id: g.line, c: g.world.c, wx: g.world.wx, wy: g.world.wy, r, label: pretty(g.label), kind: g.verb, tint: verbMeta(g.verb).subj, explicit: !!g.explicit, selected: g.line === S.goal });
			}
			map.setHandles(out);
		},

		position: () => lastPos,

		// Edit mode: the legs of the selected step can be bent (map 'leg').
		editLegs(on) {
			map.setLegHit(on ? legHit : null);
		},
	};

	// The legs of step i: per goal with a place, the track walked during its
	// travel (goal.start .. start + split.travel) on the place's continent,
	// from where the travel starts to the place. Cached per step.
	function legs(i) {
		const tl = S.timeline;
		if (legsKey && legsKey.tl === tl && legsKey.i === i) return legsOf;
		legsKey = { tl, i };
		legsOf = [];
		const step = tl && tl.steps[i];
		if (!step) return legsOf;
		const tr = tl.track;
		for (const g of step.goals) {
			const travel = g.split ? g.split.travel || 0 : 0;
			if (!g.applies || g.skip || !g.at || !(travel > 0)) continue;
			const t0 = g.start, t1 = g.start + travel;
			const c = g.at.c;
			const a = position(t0);
			if (!a || a.c !== c) continue;
			const pts = [a.wx, a.wy];
			for (let j = Math.max(0, step.k0 || 0); j <= step.k1 && j < tr.t.length; j++) {
				if (tr.t[j] <= t0 || tr.t[j] >= t1 || tr.c[j] !== c) continue;
				pts.push(tr.x[j], tr.y[j]);
			}
			pts.push(g.at.wx, g.at.wy);
			if (pts.length < 4) continue;
			legsOf.push({ key: `${i}:${g.line}`, goal: g, c, pts: new Float32Array(pts), from: { wx: a.wx, wy: a.wy }, to: { wx: g.at.wx, wy: g.at.wy } });
		}
		return legsOf;
	}

	// The leg of the selected step under screen point (sx, sy), within 7 px.
	function legHit(sx, sy) {
		if (S.mode !== 'edit' || S.adding || !S.timeline || S.step < 0 || !S.layers.route) return null;
		let best = null;
		let bestD = 7;
		for (const leg of legs(S.step)) {
			const p = leg.pts;
			let prev = map.toScreen(leg.c, p[0], p[1]);
			if (!prev) continue;
			for (let k = 2; k < p.length; k += 2) {
				const q = map.toScreen(leg.c, p[k], p[k + 1]);
				const dx = q.x - prev.x, dy = q.y - prev.y;
				const l2 = dx * dx + dy * dy;
				const f = l2 > 0 ? Math.max(0, Math.min(1, ((sx - prev.x) * dx + (sy - prev.y) * dy) / l2)) : 0;
				const px = prev.x + dx * f, py = prev.y + dy * f;
				const d = Math.hypot(sx - px, sy - py);
				if (d < bestD) {
					bestD = d;
					best = { ...leg, sx: px, sy: py };
				}
				prev = q;
			}
		}
		return best;
	}
}
