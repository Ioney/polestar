// Playback lookups on the timeline: the character's position at a time
// (binary search in track, interpolated within a segment) and the
// character's state (the step's start state advanced by its events).
import { S } from './state.js';

export const MODE_NAMES = ['stand', 'walk', 'fight', 'fly', 'boat', 'teleport', 'ride', 'swim', 'fall', 'climb', 'lift', 'indoor'];
const TELEPORT = 5;

// Last sample index k with track.t[k] <= t (0 when t is before the first).
export function sampleAt(t) {
	const tt = S.timeline.track.t;
	let lo = 0;
	let hi = tt.length - 1;
	if (hi < 0) return -1;
	if (t >= tt[hi]) return hi;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (tt[mid] <= t) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

// -> { c, wx, wy, m } | null. Between two samples on one continent the
// character moves linearly; a teleport or a continent change jumps at the
// segment's end; a stand segment holds still (both samples are one place).
export function position(t) {
	const tr = S.timeline && S.timeline.track;
	if (!tr || !tr.t.length) return null;
	const k = sampleAt(t);
	const n = tr.t.length;
	if (k >= n - 1) return { c: tr.c[n - 1], wx: tr.x[n - 1], wy: tr.y[n - 1], m: 0 };
	const t0 = tr.t[k];
	const t1 = tr.t[k + 1];
	const m = tr.m[k + 1];
	if (tr.c[k] !== tr.c[k + 1] || m === TELEPORT || t1 <= t0) return { c: tr.c[k], wx: tr.x[k], wy: tr.y[k], m };
	const f = Math.max(0, Math.min(1, (t - t0) / (t1 - t0)));
	return {
		c: tr.c[k],
		wx: tr.x[k] + (tr.x[k + 1] - tr.x[k]) * f,
		wy: tr.y[k] + (tr.y[k + 1] - tr.y[k]) * f,
		m,
	};
}

// The goal of step i in progress at t (the first goal not yet ended), or null.
export function goalAt(i, t) {
	const step = S.timeline && S.timeline.steps[i];
	if (!step) return null;
	let last = null;
	for (const g of step.goals) {
		if (!g.applies || g.skip) continue;
		last = g;
		if (g.end > t) return g;
	}
	return last;
}

// Number of events of step i that happened by t: the key the character
// panel redraws on.
export function eventsBy(i, t) {
	const { ev0 } = S.stepIndex;
	const ev = S.timeline.events;
	let k = ev0[i];
	const end = ev0[i + 1];
	while (k < end && ev[k].t <= t) k++;
	return k;
}

function cloneState(st) {
	return {
		level: st.level,
		xp: st.xp,
		xpMax: st.xpMax,
		log: (st.log || []).map((q) => ({ ...q, objectives: (q.objectives || []).map((o) => ({ ...o })) })),
		items: (st.items || []).map((it) => ({ ...it })),
		bind: st.bind || null,
		hearthReady: !!st.hearthReady,
		hearthAt: st.hearthAt == null ? null : st.hearthAt,
		fps: [...(st.fps || [])],
		mounted: !!st.mounted,
	};
}

// The character at time t in step i: step.state, then the step's events up to t.
export function stateAt(i, t) {
	const tl = S.timeline;
	const step = tl.steps[i];
	const st = cloneState(step.state || {});
	const { ev0 } = S.stepIndex;
	const upto = eventsBy(i, t);
	for (let k = ev0[i]; k < upto; k++) applyEvent(st, tl.events[k]);
	if (st.hearthAt != null && st.hearthAt <= t) {
		st.hearthAt = null;
		st.hearthReady = true;
	}
	return st;
}

function applyEvent(st, e) {
	if (e.level != null) {
		st.level = e.level;
		st.xp = e.xp;
		st.xpMax = e.xpMax;
	}
	switch (e.type) {
		case 'accept': {
			const q = e.quest || {};
			if (!st.log.some((x) => x.id === q.id)) {
				st.log.push({ id: q.id, title: q.title, objectives: (e.objectives || []).map((o) => ({ ...o })), ready: !(e.objectives || []).length });
			}
			break;
		}
		case 'progress': {
			const q = st.log.find((x) => x.id === e.quest);
			const o = q && q.objectives[(e.oi || 1) - 1];
			if (o) {
				o.cur = e.cur;
				if (e.max != null) o.max = e.max;
			}
			break;
		}
		case 'ready': {
			const q = st.log.find((x) => x.id === e.quest);
			if (q) q.ready = true;
			break;
		}
		case 'turnin':
			st.log = st.log.filter((x) => x.id !== e.quest);
			break;
		case 'item': {
			const it = st.items.find((x) => x.id === e.id);
			if (e.count <= 0) st.items = st.items.filter((x) => x.id !== e.id);
			else if (it) it.count = e.count;
			else st.items.push({ id: e.id, name: e.name, count: e.count });
			break;
		}
		case 'bind':
			st.bind = { name: e.name, c: e.c, wx: e.wx, wy: e.wy };
			break;
		case 'fp':
			if (!st.fps.includes(e.name)) st.fps.push(e.name);
			break;
		case 'hearth':
			st.hearthReady = false;
			st.hearthAt = e.readyAt;
			break;
		default:
			break;
	}
}
