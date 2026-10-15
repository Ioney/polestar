// The transport (bottom): previous/play/next step, the clock, the scrubber
// with guide bounds and dings, the speed and the totals: levels, quests,
// the walks routed on the navigation grid (or the legs still being routed)
// and the estimate legend.
import { h, clear, glyph, dropdown, fmtClock, fmtInt } from './dom.js';
import { S } from './state.js';

export const SPEEDS = [1, 2, 4, 8, 16, 32, 64, 128, 256];

export function transport(root, ctx) {
	const playBtn = h('button.play', { title: 'Play / pause (Space)', 'aria-label': 'Play', onclick: ctx.togglePlay });
	const now = h('span');
	const total = h('span');
	const fill = h('div.scrub-fill');
	const knob = h('div.scrub-knob');
	const ticks = h('div.scrub-ticks');
	const tip = h('div.scrub-tip', { hidden: true });
	const scrub = h('div.scrub', { title: '' }, h('div.scrub-track'), fill, ticks, knob, tip);
	const speed = h('select', { title: 'Playback speed' }, SPEEDS.map((s) => h('option', { value: s }, `${s}×`)));
	const legend = h('div.tlegend');
	const routed = h('span');
	speed.addEventListener('change', () => ctx.setSpeed(Number(speed.value)));
	clear(root).append(
		playBtn,
		h('button.btn.icon', { title: 'Previous step (←)', 'aria-label': 'Previous step', onclick: () => ctx.stepBy(-1) }, glyph('step-back')),
		h('button.btn.icon', { title: 'Next step (→)', 'aria-label': 'Next step', onclick: () => ctx.stepBy(1) }, glyph('step-forward')),
		h('div.clock', now, h('span', ' / '), total),
		scrub,
		h('label.speed', 'Speed', dropdown(speed)),
		legend);

	let shownSec = -1;
	let dings = [];
	let dur = 0;
	let playing = null;

	const timeAt = (clientX) => {
		const r = scrub.getBoundingClientRect();
		return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * dur;
	};
	let dragging = false;
	scrub.addEventListener('pointerdown', (e) => {
		if (!dur) return;
		dragging = true;
		scrub.setPointerCapture(e.pointerId);
		ctx.seek(timeAt(e.clientX), { scrub: true });
	});
	scrub.addEventListener('pointermove', (e) => {
		if (!dur) return;
		const t = timeAt(e.clientX);
		if (dragging) ctx.seek(t, { scrub: true });
		const r = scrub.getBoundingClientRect();
		tip.hidden = false;
		tip.style.left = `${e.clientX - r.left}px`;
		const i = ctx.stepAt(t);
		const st = S.timeline && S.timeline.steps[i];
		const g = st && S.timeline.guides[st.gi];
		// the level there, and a ding within 4 px of the pointer
		const near = (4 / r.width) * dur;
		const ding = dings.find((e) => Math.abs(e.t - t) <= near);
		const lvl = ding ? `Level ${ding.level}` : st ? `Level ${st.levelStart}` : '';
		tip.textContent = [fmtClock(t), lvl, g && g.title, st && `${i + 1}. ${st.title || st.label || ''}`].filter(Boolean).join(' · ');
	});
	const end = (e) => {
		if (!dragging) return;
		dragging = false;
		ctx.seek(timeAt(e.clientX), { scrub: false });
	};
	scrub.addEventListener('pointerup', end);
	scrub.addEventListener('pointercancel', end);
	scrub.addEventListener('pointerleave', () => (tip.hidden = true));

	return {
		setTimeline() {
			const tl = S.timeline;
			clear(ticks);
			dur = tl ? tl.totals.seconds : 0;
			total.textContent = fmtClock(dur);
			shownSec = -1;
			if (!tl || !dur) {
				legend.textContent = '';
				return;
			}
			for (const g of tl.guides.slice(1)) ticks.append(h('i.gb', { style: { left: `${(g.start / dur) * 100}%` } }));
			dings = tl.events.filter((e) => e.type === 'ding');
			for (const e of dings) ticks.append(h('i.dg', { style: { left: `${(e.t / dur) * 100}%` } }));
			const est = tl.steps.filter((s) => s.estimate).length;
			const tt = tl.totals;
			const first = [];
			if (tt.level) first.push(`Level ${tl.steps[0] ? tl.steps[0].levelStart : ''} → ${tt.level}`);
			first.push(`${fmtInt(tt.quests || 0)} quests`);
			const line = h('div', first.join(' · '));
			if (tl.nav) line.append(' · ', routed);
			else line.append(` · ${fmtInt(tl.steps.length - est)} of ${fmtInt(tl.steps.length)} steps modelled`);
			this.setRouting();
			clear(legend).append(
				line,
				h('div', h('span.est', { title: tl.nav ? 'Steps whose time rests on a guess: straight-line walks (distance times a detour factor) the grid could not route yet, unmodelled goals, estimated quest XP' : 'Steps whose time rests on a guess; walks are straight lines times a detour factor' }, glyph('warning'), `${fmtInt(est)} estimated steps`)));
		},
		// The routed count, or the progress while the server routes the walks (S.routing).
		setRouting() {
			const tl = S.timeline;
			if (!tl || !tl.nav) return;
			const r = S.routing;
			// S.routing stays set until the routed timeline is loaded (app.js refetches it).
			if (r) {
				routed.textContent = `Routing… ${fmtInt(r.done)}/${fmtInt(r.pending + r.done)}`;
				routed.title = 'Walks being routed on the navigation grid; the times update when they are done';
			} else {
				const tt = tl.totals;
				routed.textContent = `Routed ${fmtInt(tt.routed)} of ${fmtInt(tt.legs)} legs${tt.hops ? ` · ${fmtInt(tt.hopsRouted || 0)} of ${fmtInt(tt.hops)} hops` : ''}`;
				routed.title = `Walks on the navigation grid (legs between places, hops between spawns in kill and collect areas): ${fmtClock(tt.routeSeconds || 0)}; straight-line estimates: ${fmtClock(tt.estimateSeconds || 0)}`;
			}
		},
		setTime(t) {
			const p = dur ? (t / dur) * 100 : 0;
			fill.style.width = `${p}%`;
			knob.style.left = `${p}%`;
			const sec = Math.floor(t);
			if (sec !== shownSec) {
				shownSec = sec;
				now.textContent = fmtClock(t);
			}
		},
		setPlaying(on) {
			if (on === playing) return;
			playing = on;
			clear(playBtn).append(glyph(on ? 'pause' : 'play'));
			playBtn.setAttribute('aria-label', on ? 'Pause' : 'Play');
		},
		setSpeed(s) {
			speed.value = String(s);
		},
	};
}
