// The steps list (left): guide headers and step rows of the whole route,
// virtualised (only the rows in view are in the DOM; routes run to
// thousands of steps). Row heights follow from the data, so offsets are
// computed once per timeline.
import { h, clear, fmtClock, verbMeta, nameColor, goalText, goalIconEl, glyph, dropdown } from './dom.js';
import { S } from './state.js';

const HEAD_H = 56;
const STEP_PAD = 6 + 22 + 8;
const GOAL_H = 20;
const MORE_H = 18;
const KILLS_H = 18;
const MAX_GOALS = 3;
const SPLIT = [['travel', 'Travel'], ['combat', 'Combat'], ['interact', 'Interact'], ['wait', 'Wait']];

// A step's diagnostics: the loaded GuideView's, the last lint run's and the
// playback's warnings (severity 'playback').
export function stepDiagnostics(i) {
	const tl = S.timeline;
	const step = tl.steps[i];
	const g = tl.guides[step.gi];
	const end = S.stepIndex.endLine[i];
	const out = [];
	const view = S.views.get(g.id);
	if (view) for (const d of view.diagnostics || []) if (d.line >= step.line && d.line <= end) out.push(d);
	if (S.lint && S.lint.length) {
		for (const d of S.lint) {
			if (d.file && g.file && (d.file === g.file || d.file.endsWith(g.file) || g.file.endsWith(d.file)) && d.line >= step.line && d.line <= end) {
				if (!out.some((x) => x.line === d.line && x.message === d.message)) out.push(d);
			}
		}
	}
	for (const w of S.stepIndex.warnings.get(i) || []) out.push({ severity: 'playback', line: w.line, message: w.message });
	return out;
}

function shownGoals(step) {
	return step.goals.filter((g) => g.verb !== 'note');
}

function killsOf(step) {
	let n = 0;
	const names = [];
	for (const g of step.goals) {
		if (!g.kills || !g.applies || g.skip) continue;
		n += g.kills;
		const name = (g.spawns && g.spawns.name) || goalText(g);
		const k = Math.round(g.kills);
		names.push(`${name} ×${k}`);
	}
	return n > 0 ? { n: Math.round(n), names } : null;
}

export function stepsList(root, { onSelect, onChoice }) {
	const spacer = root.querySelector('.vlist-spacer');
	let items = [];          // [{ kind: 'guide', gi } | { kind: 'step', i }]
	let tops = new Float64Array(0);
	let heights = new Float64Array(0);
	let rowOfStep = new Int32Array(0);
	let rendered = new Map(); // item index -> element
	let frame = 0;
	let userScrollAt = 0;
	const pinEl = root.querySelector('.vlist-pin');
	let pinned = -1;
	const legend = document.getElementById('steps-legend');
	clear(legend).append(
		...SPLIT.map(([k, l]) => h('span', h('i', { style: { background: `var(--${k})` } }), l)),
		h('span.est', { title: 'A step time in this colour rests on a guess' }, glyph('warning'), 'Estimate'));

	function layout() {
		const tl = S.timeline;
		items = [];
		if (tl) {
			for (let gi = 0; gi < tl.guides.length; gi++) {
				const g = tl.guides[gi];
				items.push({ kind: 'guide', gi });
				for (let i = g.s0; i <= g.s1; i++) items.push({ kind: 'step', i });
			}
		}
		tops = new Float64Array(items.length + 1);
		heights = new Float64Array(items.length);
		rowOfStep = new Int32Array(tl ? tl.steps.length : 0);
		let y = 0;
		items.forEach((it, k) => {
			let hh = HEAD_H;
			if (it.kind === 'step') {
				const step = tl.steps[it.i];
				const goals = shownGoals(step);
				hh = STEP_PAD + Math.min(goals.length, MAX_GOALS) * GOAL_H + (goals.length > MAX_GOALS ? MORE_H : 0) + (killsOf(step) ? KILLS_H : 0);
				rowOfStep[it.i] = k;
			}
			tops[k] = y;
			heights[k] = hh;
			y += hh;
		});
		tops[items.length] = y;
		spacer.style.height = `${y}px`;
		document.getElementById('steps-count').textContent = tl ? tl.steps.length.toLocaleString('en-US') : '';
	}

	function firstVisible(y) {
		let lo = 0;
		let hi = items.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (tops[mid] <= y) lo = mid;
			else hi = mid - 1;
		}
		return lo;
	}

	function buildGuide(gi) {
		const tl = S.timeline;
		const g = tl.guides[gi];
		const info = S.guideById.get(g.id);
		const lv = info && info.levels ? `${info.levels.min}–${info.levels.max}` : `${g.levelStart}–${g.levelEnd}`;
		const meta = h('div.gm',
			h('span', `${fmtClock(g.start)} – ${fmtClock(g.end)}`),
			h('span', `Level ${g.levelStart} → ${g.levelEnd}`));
		const options = g.choices || (info && info.nextChoices) || [];
		if (options.length > 1) {
			const sel = h('select', { title: 'Route choice: the guide that follows', onchange: (e) => onChoice(g.id, e.target.value), onclick: (e) => e.stopPropagation() },
				options.map((id) => h('option', { value: id, selected: id === g.next }, `Then ${(S.guideById.get(id) || {}).title || id}`)));
			meta.append(h('span.spacer'), dropdown(sel, 'quiet small'));
		} else if (g.next) {
			meta.append(h('span.spacer'), h('span.next', { title: 'The guide that follows' }, glyph('chevron-right'), (S.guideById.get(g.next) || {}).title || g.next));
		}
		return h('div.vrow.ghead', { 'data-guide': gi }, h('div.gt', h('span', { title: g.id }, g.title || g.id), h('span.chip.accent', lv)), meta);
	}

	function buildStep(i) {
		const tl = S.timeline;
		const step = tl.steps[i];
		const goals = shownGoals(step);
		const dur = step.end - step.start;
		const sp = step.split || {};
		const total = (sp.travel || 0) + (sp.combat || 0) + (sp.interact || 0) + (sp.wait || 0);
		const bar = h('div.st-bar', { title: SPLIT.filter(([k]) => sp[k] > 0).map(([k, l]) => `${l} ${fmtClock(sp[k])}`).join(' · ') });
		if (total > 0) {
			for (const [k] of SPLIT) {
				if (sp[k] > 0) bar.append(h('i', { style: { width: `${(sp[k] / total) * 100}%`, background: `var(--${k})` } }));
			}
		}
		const head = h('div.st-head',
			h('span.st-time', fmtClock(step.start)),
			h('span.st-num', String(i + 1)),
			h('span.st-title', { title: step.title || step.label || '' }, step.title || step.label || '(untitled step)'));
		for (const n of step.dings || []) head.append(h('span.chip.ding', { title: `Reaches level ${n} in this step` }, 'DING ', h('b', String(n))));
		const diags = stepDiagnostics(i);
		if (diags.length) {
			const errs = diags.filter((d) => d.severity === 'error').length;
			head.append(h('span', { class: `diag-badge${errs ? '' : ' warn'}`, title: diags.map((d) => `${d.line}: ${d.message}`).join('\n') }, glyph('warning'), String(diags.length)));
		}
		head.append(h('span', { class: `st-dur${step.estimate ? ' est' : ''}`, title: step.estimate ? 'Estimate: rests on a guess (a straight-line walk, an unmodelled goal, estimated quest XP or no place)' : 'Step time' }, fmtClock(dur), bar));
		const el = h('div.vrow.step', { class: `vrow step${step.applies ? '' : ' na'}`, 'data-step': i }, head);
		for (const g of goals.slice(0, MAX_GOALS)) {
			const meta = verbMeta(g.verb);
			el.append(h('div', { class: `st-goal${g.skip || !g.applies ? ' skip' : ''}`, title: g.skip ? `Skipped: ${g.skip}` : g.label },
				goalIconEl(g, S.character),
				h('span.verb', meta.label),
				h('span', { class: `g-text c-${nameColor(g.verb)}` }, goalText(g)),
				g.routeReason ? h('span.g-est', { title: `Straight-line walk (${g.routeReason === 'pending' ? 'being routed' : g.routeReason}): its time is an estimate` }, '≈') : null));
		}
		if (goals.length > MAX_GOALS) el.append(h('div.st-more', `${goals.length - MAX_GOALS} more`));
		const kills = killsOf(step);
		if (kills) el.append(h('div.st-kills', { title: kills.names.join(', ') }, glyph('icon-kill'), h('span', h('b', `${kills.n} ${kills.n === 1 ? 'kill' : 'kills'}`), ` · ${kills.names.join(', ')}`)));
		if (i === S.step) el.classList.add('sel');
		return el;
	}

	// The header of the guide the top of the list is in, pinned; the next
	// guide's header pushes it up.
	function pin() {
		if (!items.length) {
			clear(pinEl);
			pinned = -1;
			return;
		}
		const y = root.scrollTop;
		const k = firstVisible(y);
		let gk = k;
		while (gk > 0 && items[gk].kind !== 'guide') gk--;
		const gi = items[gk].gi;
		if (gi !== pinned) {
			pinned = gi;
			clear(pinEl).append(buildGuide(gi));
			pinEl.firstChild.style.height = `${HEAD_H}px`;
		}
		let next = gk + 1;
		while (next < items.length && items[next].kind !== 'guide') next++;
		const push = next < items.length ? Math.min(0, tops[next] - y - HEAD_H) : 0;
		pinEl.firstChild.style.transform = push ? `translateY(${push}px)` : '';
	}

	function skeleton() {
		clear(pinEl);
		pinned = -1;
		for (const el of rendered.values()) el.remove();
		rendered.clear();
		spacer.style.height = '0px';
		for (let k = 0; k < 9; k++) {
			const el = h('div.vrow.skel', h('i'), h('i'), h('i'));
			el.style.transform = `translateY(${k * 76}px)`;
			rendered.set(-1 - k, el);
			root.append(el);
		}
	}

	function render() {
		frame = 0;
		if (!items.length) {
			for (const el of rendered.values()) el.remove();
			rendered.clear();
			pin();
			return;
		}
		const y0 = root.scrollTop;
		const y1 = y0 + root.clientHeight;
		const a = Math.max(0, firstVisible(y0) - 4);
		let b = firstVisible(y1) + 4;
		b = Math.min(items.length - 1, b);
		for (const [k, el] of rendered) {
			if (k < a || k > b) {
				el.remove();
				rendered.delete(k);
			}
		}
		for (let k = a; k <= b; k++) {
			if (rendered.has(k)) continue;
			const it = items[k];
			const el = it.kind === 'guide' ? buildGuide(it.gi) : buildStep(it.i);
			el.style.transform = `translateY(${tops[k]}px)`;
			el.style.height = `${heights[k]}px`;
			rendered.set(k, el);
			root.append(el);
		}
		pin();
	}

	const schedule = () => {
		if (!frame) frame = requestAnimationFrame(render);
	};
	root.addEventListener('scroll', schedule, { passive: true });
	root.addEventListener('wheel', () => (userScrollAt = performance.now()), { passive: true });
	root.addEventListener('pointerdown', (e) => {
		if (e.target === root) userScrollAt = performance.now();
	});
	new ResizeObserver(schedule).observe(root);
	root.addEventListener('click', (e) => {
		const row = e.target.closest('.step');
		if (!row) return;
		onSelect(Number(row.dataset.step));
	});

	return {
		// The timeline is loading: skeleton rows until reset().
		loading: skeleton,
		// The timeline changed: lay out again and redraw every row.
		reset() {
			pinned = -1;
			layout();
			for (const el of rendered.values()) el.remove();
			rendered.clear();
			render();
		},
		// Diagnostics or names changed: redraw the rows in view.
		refresh() {
			for (const el of rendered.values()) el.remove();
			rendered.clear();
			pinned = -1;
			render();
		},
		select(prev, next) {
			for (const el of rendered.values()) {
				if (!el.dataset.step) continue;
				const i = Number(el.dataset.step);
				if (i === prev || i === next) el.classList.toggle('sel', i === next);
			}
		},
		// Keeps step i in view; `force` ignores a recent manual scroll.
		reveal(i, force = false) {
			if (i < 0 || i >= rowOfStep.length) return;
			if (!force && performance.now() - userScrollAt < 3000) return;
			const k = rowOfStep[i];
			const top = tops[k];
			const bottom = top + heights[k];
			const view = root.clientHeight;
			if (top < root.scrollTop + 8 || bottom > root.scrollTop + view - 8) {
				root.scrollTop = Math.max(0, top - view * 0.35);
			}
		},
	};
}
