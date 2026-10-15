// The right panel in edit mode: the selected step's title, tip, only and
// zone, its diagnostics, and one card per goal built from verbs_schema.
// Every change is one source edit (setStep / setGoal / insertGoal / ...);
// the server's refusal shows inline on the card.
import { h, clear, glyph, dropdown, verbMeta, goalIconEl, pretty, popover, closePopover } from './dom.js';
import { S } from './state.js';
import { findPopover } from './find.js';
import { toast } from './toasts.js';

const LOCATED_VERBS = new Set(['goto', 'explore']);

// The text of a zone spec for the zone input.
function zoneText(z) {
	if (!z) return '';
	if (typeof z === 'string') return z;
	if (z.name) return z.name;
	if (z.map != null) return `map ${z.map}`;
	return '';
}

// Fields a verb accepts (its schema keys, coordinates as x/y, the note and
// the parser's derived flags), so changing the verb drops what it cannot take.
function allowedKeys(verb) {
	const sc = S.verbs && S.verbs[verb];
	const out = new Set(['verb', 'note', 'explicitCoords', 'npcExplicit', 'objectExplicit', 'itemExplicit', 'skillQuoted', 'factionQuoted']);
	if (!sc) return out;
	for (const f of [...sc.positional, ...sc.modifiers]) {
		if (f.keys) for (const k of f.keys) out.add(k);
		else out.add(f.key);
	}
	return out;
}

function hasValue(f, fields) {
	if (f.keys) return f.keys.some((k) => fields[k] !== undefined && fields[k] !== null);
	const v = fields[f.key];
	return v !== undefined && v !== null && v !== '' && v !== false;
}

function itemsText(list) {
	return (list || []).map((it) => it.item).join(', ');
}
function parseItems(text, prev) {
	const ids = String(text).split(/[\s,]+/).filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n > 0);
	if (!ids.length) return undefined;
	return ids.map((id) => (prev || []).find((it) => it.item === id) || { item: id });
}

// One input for a schema field. -> { el, read(fields) } where read writes the
// field's value into `fields` (undefined removes it).
function fieldControl(f, fields, { onChange, focusKey }) {
	const fire = () => onChange();
	const num = (v) => (v === '' || v == null ? undefined : Number(v));
	const attrs = (k) => ({ 'data-focus': `${focusKey}:${k}`, onchange: fire });
	switch (f.type) {
		case 'coords': {
			const [kx, ky] = f.keys || ['x', 'y'];
			const x = h('input', { type: 'number', step: '0.1', placeholder: 'x', value: fields[kx] != null ? fields[kx] : '', ...attrs(kx) });
			const y = h('input', { type: 'number', step: '0.1', placeholder: 'y', value: fields[ky] != null ? fields[ky] : '', ...attrs(ky) });
			return {
				el: h('div.row', x, y),
				read(out) {
					out[kx] = num(x.value);
					out[ky] = num(y.value);
				},
			};
		}
		case 'bool': {
			const b = h('button', { class: `tog${fields[f.key] ? ' on' : ''}`, type: 'button', 'data-focus': `${focusKey}:${f.key}` }, h('span.sw'), f.label);
			b.addEventListener('click', () => {
				b.classList.toggle('on');
				fire();
			});
			return { el: b, toggle: true, read: (out) => (out[f.key] = b.classList.contains('on') ? true : undefined) };
		}
		case 'enum': {
			const sel = h('select', attrs(f.key),
				h('option', { value: '' }, '—'),
				(f.values || []).map((v) => h('option', { value: String(v.value), selected: String(fields[f.key]) === String(v.value) }, v.label)));
			return {
				el: dropdown(sel),
				read(out) {
					if (sel.value === '') out[f.key] = undefined;
					else {
						const v = (f.values || []).find((x) => String(x.value) === sel.value);
						out[f.key] = v ? v.value : sel.value;
					}
				},
			};
		}
		case 'items': {
			const inp = h('input', { type: 'text', placeholder: 'item ids, comma separated', value: itemsText(fields[f.key]), ...attrs(f.key) });
			return { el: inp, read: (out) => (out[f.key] = parseItems(inp.value, fields[f.key])) };
		}
		case 'group': {
			const g = fields[f.key];
			const inp = h('input', { type: 'text', placeholder: 'off · on · size (2-40)', value: g ? (g.size != null ? String(g.size) : 'on') : '', ...attrs(f.key) });
			return {
				el: inp,
				read(out) {
					const v = inp.value.trim().toLowerCase();
					out[f.key] = !v || v === 'off' ? undefined : /^\d+$/.test(v) ? { size: Number(v) } : {};
				},
			};
		}
		case 'id':
		case 'int':
		case 'number':
		case 'money': {
			const inp = h('input', { type: 'number', step: f.type === 'number' ? 'any' : '1', value: fields[f.key] != null ? fields[f.key] : '', ...attrs(f.key) });
			if (f.type !== 'id' || !f.kind || !['quest', 'npc', 'object', 'item'].includes(f.kind)) {
				return { el: inp, read: (out) => (out[f.key] = num(inp.value)) };
			}
			const hint = h('div.id-name');
			const btn = h('button.btn.small', { type: 'button', title: `Find the ${f.kind} by name` }, glyph('search'), 'Find');
			btn.addEventListener('click', () => findPopover(btn, {
				kind: f.kind,
				onPick(r) {
					inp.value = r.id;
					hint.textContent = r.name;
					fire();
				},
			}));
			return { el: h('div', { style: { display: 'contents' } }, h('div.row', inp, btn), hint), read: (out) => (out[f.key] = num(inp.value)) };
		}
		default: {
			// text; `kind` (inn, flight) names a find lookup that fills the name
			const inp = h('input', { type: 'text', value: fields[f.key] != null ? fields[f.key] : '', ...attrs(f.key) });
			if (!f.kind) return { el: inp, read: (out) => (out[f.key] = inp.value === '' ? undefined : inp.value) };
			const btn = h('button.btn.small', { type: 'button', title: `Find the ${f.kind} by name` }, glyph('search'), 'Find');
			btn.addEventListener('click', () => findPopover(btn, {
				kind: f.kind,
				text: inp.value,
				onPick(r) {
					inp.value = r.name;
					fire();
				},
			}));
			return { el: h('div.row', inp, btn), read: (out) => (out[f.key] = inp.value === '' ? undefined : inp.value) };
		}
	}
}

// The form fields (positional and the set modifiers) of a goal card.
function goalBody(goal, { onSave, focusKey, extra }) {
	const sc = S.verbs[goal.verb] || { positional: [], modifiers: [], note: { key: 'note', type: 'text', label: 'Note' } };
	const body = h('div.gcard-body');
	const controls = [];
	const toggles = h('div.toggles');
	const fields = goal.fields || {};
	const shown = new Set(extra);
	const add = (f) => {
		const c = fieldControl(f, fields, { onChange: onSave, focusKey });
		controls.push(c);
		if (c.toggle) toggles.append(c.el);
		else body.append(h('label', { title: f.label }, f.label.replace(/ \(.*\)$/, '')), c.el);
	};
	for (const f of sc.positional) add(f);
	const more = [];
	for (const f of sc.modifiers) {
		if (f.type === 'bool' || hasValue(f, fields) || shown.has(f.key)) add(f);
		else more.push(f);
	}
	if (fields.note != null || shown.has('note')) add(sc.note || { key: 'note', type: 'text', label: 'Note' });
	else more.push(sc.note || { key: 'note', type: 'text', label: 'Note' });
	if (toggles.children.length) body.append(toggles);
	return { body, controls, more };
}

// DESIGN's Confirm: an icon button that arms on the first click ("Click
// again to confirm", in danger) and acts only on a second click within 3 s.
function confirmButton(title, label, act) {
	const btn = h('button.btn.small.icon.danger', { title, 'aria-label': label }, glyph('cross'));
	let timer = 0;
	const disarm = () => {
		clearTimeout(timer);
		timer = 0;
		btn.classList.remove('armed');
		clear(btn).append(glyph('cross'));
		btn.title = title;
	};
	btn.addEventListener('click', () => {
		if (timer) {
			disarm();
			act();
			return;
		}
		btn.classList.add('armed');
		clear(btn).append(glyph('cross'), 'Click again to confirm');
		btn.title = 'Click again within 3 seconds to confirm';
		timer = setTimeout(disarm, 3000);
	});
	return btn;
}

export function stepEditor(root, ctx) {
	const head = h('div.panel-head', h('h2', 'Step editor'), h('span.spacer'));
	const body = h('div.side-body');
	const el = h('div', { style: { display: 'contents' } }, head, body);
	root.append(el);
	let shown = null;         // { view, vstep, tlStep }
	let opened = false;       // a new step: the next render starts at the top
	let stepNum = null;       // the header's step number, null while no step is drawn
	let diagBox = null;       // the diagnostics block
	const extras = new Map(); // goal line -> Set of modifier keys opened with "+"
	const errors = new Map(); // goal line -> message

	// An input typed into since its last commit (change) is dirty: a rebuild
	// keeps its text, so a new view never replaces what is being typed.
	let rebuilding = false;
	body.addEventListener('input', (e) => {
		if (e.target.hasAttribute && e.target.hasAttribute('data-focus')) e.target.dataset.dirty = '1';
	});
	// Removing a focused, typed-in input fires its change: a rebuild must not
	// commit half-typed text (capture runs before the input's own handlers).
	body.addEventListener('change', (e) => {
		if (rebuilding) e.stopPropagation();
	}, true);
	body.addEventListener('change', (e) => {
		if (e.target.dataset) delete e.target.dataset.dirty;
	});

	function stepOp(op, label) {
		return ctx.apply([op], label).catch((e) => {
			toast(e.message, 'error');
			throw e;
		});
	}

	const byFocus = (key) => body.querySelector(`[data-focus="${CSS.escape(key)}"]`);

	// The focused input (with its caret) and the dirty inputs' text.
	function keepInputs() {
		const a = document.activeElement && body.contains(document.activeElement) ? document.activeElement : null;
		const kept = { focus: a ? a.getAttribute('data-focus') : null, sel: null, dirty: [] };
		if (a && typeof a.selectionStart === 'number') kept.sel = [a.selectionStart, a.selectionEnd];
		for (const d of body.querySelectorAll('[data-dirty]')) kept.dirty.push([d.getAttribute('data-focus'), d.value]);
		return kept;
	}
	function restoreInputs(kept) {
		for (const [key, value] of kept.dirty) {
			const d = byFocus(key);
			if (!d) continue;
			d.value = value;
			d.dataset.dirty = '1';
		}
		if (!kept.focus) return;
		const a = byFocus(kept.focus);
		if (!a) return;
		a.focus();
		if (kept.sel && typeof a.selectionStart === 'number') a.setSelectionRange(kept.sel[0], kept.sel[1]);
		// The browser saw no typing in this new input: leaving it commits the
		// kept text as the old one would have (unless a change already did).
		if (a.dataset.dirty) a.addEventListener('blur', () => {
			if (a.dataset.dirty && a.isConnected) a.dispatchEvent(new Event('change', { bubbles: true }));
		}, { once: true });
	}

	function stepLabel() {
		const { vstep, tlStep } = shown;
		return `Step ${tlStep != null ? tlStep + 1 : vstep.index + 1}`;
	}

	// Diagnostics on the step's lines and the step's playback warnings.
	function renderDiags() {
		const { view, vstep, tlStep } = shown;
		clear(diagBox);
		const diags = (view.diagnostics || []).filter((d) => d.line >= vstep.line && d.line <= vstep.end);
		if (tlStep != null && S.stepIndex) for (const w of S.stepIndex.warnings.get(tlStep) || []) diags.push({ severity: 'playback', line: w.line, message: w.message });
		if (!diags.length) return;
		diagBox.append(h('div.ed-sec', 'Diagnostics', h('span.count', String(diags.length))));
		diagBox.append(h('div.diags', diags.map((d) => h('div', { class: `diag ${d.severity}`, onclick: () => selectGoal(d.line) },
			glyph(d.severity === 'info' || d.severity === 'playback' ? 'info' : 'warning'), h('span.ln', `${d.line}`), h('span', d.message), d.hint ? h('span.hint', d.hint) : null))));
	}

	function render() {
		const scroll = body.scrollTop;
		const kept = keepInputs();
		rebuilding = true;
		clear(body);
		rebuilding = false;
		stepNum = null;
		diagBox = null;
		if (!shown || !shown.vstep) {
			body.append(h('div.empty', { style: { padding: '16px 0' } }, shown && shown.view ? 'This step is not in the guide source any more.' : 'Select a step in the list to edit it.'));
			return;
		}
		const { view, vstep } = shown;
		const nSteps = view.steps.length;

		// Header: where, and the step's own operations.
		stepNum = h('b', stepLabel());
		body.append(h('div.ed-head',
			stepNum,
			h('span.file', { title: view.file }, `${view.file.split('/').pop()}:${vstep.line}`),
			h('span.spacer'),
			h('button.btn.small.icon', { title: 'Move step up', 'aria-label': 'Move step up', disabled: vstep.index === 0, onclick: () => stepOp({ op: 'moveStep', step: vstep.index, index: vstep.index - 1 }, 'Move step') }, glyph('chevron-up')),
			h('button.btn.small.icon', { title: 'Move step down', 'aria-label': 'Move step down', disabled: vstep.index >= nSteps - 1, onclick: () => stepOp({ op: 'moveStep', step: vstep.index, index: vstep.index + 1 }, 'Move step') }, glyph('chevron-down')),
			h('button.btn.small.icon', { title: 'Insert a step after this one', 'aria-label': 'Insert step', onclick: (e) => newStep(e.currentTarget) }, glyph('plus')),
			confirmButton(`Delete step ${vstep.index + 1} and its ${vstep.goals.length} goals`, 'Delete step', () => stepOp({ op: 'deleteStep', step: vstep.index }, 'Delete step').catch(() => {}))));

		// Step directives. The tip is multi-line: each line is one `tip` line.
		const zoneDir = (vstep.directives || []).find((d) => d.kind === 'zone');
		const stepField = (key, label, value, placeholder, multi = false) => {
			const attrs = { placeholder: placeholder || '', 'data-focus': `step:${key}` };
			const inp = multi ? h('textarea', { ...attrs, rows: Math.max(2, String(value || '').split('\n').length) }) : h('input', { type: 'text', ...attrs });
			inp.value = value || '';
			if (multi) {
				// 2-6 lines, as tall as its text (wrapped lines count)
				const fit = () => {
					if (!inp.isConnected) return;
					const cs = getComputedStyle(inp);
					const line = parseFloat(cs.lineHeight) || 17;
					const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
					const border = inp.offsetHeight - inp.clientHeight;
					inp.style.height = '0px';
					const want = Math.min(Math.max(inp.scrollHeight, line * 2 + pad), line * 6 + pad);
					inp.style.height = `${Math.ceil(want + border)}px`;
				};
				inp.addEventListener('input', fit);
				requestAnimationFrame(fit);
			}
			inp.addEventListener('change', () => {
				const v = inp.value.trim();
				stepOp({ op: 'setStep', step: vstep.index, [key]: v === '' ? null : v }, `Set step ${key}`).catch(() => {});
			});
			return [h(multi ? 'label.top' : 'label', label), inp];
		};
		body.append(h('div.ed-fields',
			stepField('title', 'Title', vstep.title),
			stepField('tip', 'Tip', vstep.tip, 'one tip per line', true),
			stepField('only', 'Only', vstep.only, 'e.g. Dwarf,Gnome'),
			stepField('zone', 'Zone', zoneDir ? (zoneDir.value != null ? zoneText(zoneDir.value) : zoneDir.raw.replace(/^\s*zone\s+/, '')) : '', zoneDir ? '' : `${zoneText(vstep.zone)} (in effect)`)));

		diagBox = h('div');
		body.append(diagBox);
		renderDiags();

		// Goals.
		const addBtn = h('button.btn.small', { title: 'Add a goal at the end of the step' }, glyph('plus'), 'Add goal');
		addBtn.addEventListener('click', () => verbMenu(addBtn, (verb) => addGoal(verb, vstep.goals.length, addBtn)));
		body.append(h('div.ed-sec', 'Goals', h('span.count', String(vstep.goals.length)), h('span.spacer'), addBtn));
		vstep.goals.forEach((g, gi) => body.append(goalCard(g, gi, vstep)));
		if (!vstep.goals.length) body.append(h('div.empty', 'No goals yet.'));

		if (opened) {
			// A new step opens at the top (Title in view), unless that would
			// leave the selected goal's card out of view.
			opened = false;
			body.scrollTop = 0;
			const c = S.goal != null ? body.querySelector(`.gcard[data-line="${S.goal}"]`) : null;
			if (c && c.getBoundingClientRect().bottom > body.getBoundingClientRect().bottom) c.scrollIntoView({ block: 'nearest' });
		} else body.scrollTop = scroll;
		restoreInputs(kept);
	}

	function goalCard(goal, gi, vstep) {
		const focusKey = `g${gi}`;
		const card = h('div', { class: `gcard${S.goal === goal.line ? ' sel' : ''}${errors.has(goal.line) ? ' err' : ''}`, 'data-line': goal.line });
		const errEl = h('div.gcard-err', errors.get(goal.line) || '');
		const save = (fieldsFrom) => {
			const fields = fieldsFrom();
			errors.delete(goal.line);
			return ctx.apply([{ op: 'setGoal', line: goal.line, fields }], `Edit ${goal.verb}`).catch((e) => {
				// stale: the card was rebuilt from the reloaded guide
				if (e.code === 'stale') return toast(e.message, 'error');
				errors.set(goal.line, e.message);
				errEl.textContent = e.message;
				card.classList.add('err');
			});
		};
		let form = null;
		const readAll = () => {
			const out = { ...goal.fields };
			for (const c of form.controls) c.read(out);
			// an emptied (or absent) note field removes the note
			if (out.note === undefined) out.note = null;
			for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
			out.verb = goal.verb;
			return out;
		};
		form = goalBody(goal, { onSave: () => save(readAll), focusKey, extra: extras.get(goal.line) || new Set() });

		const verbSel = h('select', { title: 'Verb', 'data-focus': `${focusKey}:verb` },
			Object.keys(S.verbs).map((v) => h('option', { value: v, selected: v === goal.verb }, verbMeta(v).label)));
		verbSel.addEventListener('change', () => save(() => {
			const keys = allowedKeys(verbSel.value);
			const out = {};
			for (const [k, v] of Object.entries(readAll())) if (keys.has(k)) out[k] = v;
			out.verb = verbSel.value;
			return out;
		}));
		const located = !!goal.world;
		const n = vstep.goals.length;
		const locTitle = goal.explicit ? 'Coordinates written in the guide' : 'Placed by the compiler (drag it on the map to write coordinates)';
		card.append(h('div.gcard-head',
			goalIconEl(goal, S.character, 's18'),
			dropdown(verbSel),
			h('span.ln', `L${goal.line}`),
			located ? glyph('icon-goto', `loc${goal.explicit ? ' ex' : ''}`) : null,
			h('span.spacer'),
			located ? h('button.btn.small.icon', { title: 'Show on the map', 'aria-label': 'Show on the map', onclick: () => ctx.showGoal(goal) }, glyph('fit')) : null,
			h('button.btn.small.icon', { title: 'Move goal up', 'aria-label': 'Move goal up', disabled: gi === 0, onclick: () => stepOp({ op: 'moveGoal', line: goal.line, step: vstep.index, index: gi - 1 }, 'Move goal') }, glyph('chevron-up')),
			h('button.btn.small.icon', { title: 'Move goal down', 'aria-label': 'Move goal down', disabled: gi >= n - 1, onclick: () => stepOp({ op: 'moveGoal', line: goal.line, step: vstep.index, index: gi + 1 }, 'Move goal') }, glyph('chevron-down')),
			h('button.btn.small.icon', { title: 'Insert a goal after this one', 'aria-label': 'Insert goal', onclick: (e) => verbMenu(e.currentTarget, (verb) => addGoal(verb, gi + 1, e.currentTarget)) }, glyph('plus')),
			h('button.btn.small.icon.danger', { title: 'Delete goal', 'aria-label': 'Delete goal', onclick: () => stepOp({ op: 'deleteGoal', line: goal.line }, 'Delete goal') }, glyph('cross'))));
		const locEl = card.querySelector('.loc');
		if (locEl) locEl.title = locTitle;
		const b = form.body;
		if (goal.label) b.prepend(h('div.gcard-label', pretty(goal.label)));
		// The line as written, and the modifiers not on it yet behind one menu.
		const foot = h('div.gcard-foot', h('code.gcard-raw', { title: goal.raw.trim() }, goal.raw.trim().replace(/\s{2,}/g, '  ')));
		if (form.more.length) {
			const addField = h('button.btn.small', { title: 'Add a modifier to this goal' }, glyph('plus'), 'Field');
			addField.addEventListener('click', () => popover(h('div.menu', form.more.map((f) => h('button', {
				onclick: () => {
					closePopover();
					if (!extras.has(goal.line)) extras.set(goal.line, new Set());
					extras.get(goal.line).add(f.key);
					render();
					const el = body.querySelector(`[data-focus="${focusKey}:${f.keys ? f.keys[0] : f.key}"]`);
					if (el) el.focus();
				},
			}, f.label))), addField, { align: 'right', cls: 'menu-pop' }));
			foot.append(addField);
		}
		b.append(foot, errEl);
		card.append(b);
		card.addEventListener('pointerdown', () => selectGoal(goal.line, false));
		return card;
	}

	function selectGoal(line, scroll = true) {
		if (S.goal === line) return;
		S.goal = line;
		for (const c of body.querySelectorAll('.gcard')) c.classList.toggle('sel', Number(c.dataset.line) === line);
		if (scroll) {
			const c = body.querySelector(`.gcard[data-line="${line}"]`);
			if (c) c.scrollIntoView({ block: 'nearest' });
		}
	}

	function verbMenu(anchor, onPick) {
		const menu = h('div.menu', h('div.menu-head', 'Add goal'), Object.keys(S.verbs).map((v) => {
			const m = verbMeta(v);
			const g = glyph(m.glyph);
			g.style.color = `var(--${m.subj})`;
			return h('button', { onclick: () => { closePopover(); onPick(v); } }, g, m.label);
		}));
		popover(menu, anchor, { align: 'right', cls: 'menu-pop' });
	}

	// A new goal: goto/explore at the map centre; others ask for their
	// positional fields first (with find lookups) and insert on confirm.
	function addGoal(verb, index, anchor) {
		const { vstep } = shown;
		if (LOCATED_VERBS.has(verb)) {
			ctx.insertLocated(verb, vstep.index, index).catch((e) => toast(e.message, 'error'));
			return;
		}
		const sc = S.verbs[verb];
		const defaults = { verb };
		if (verb === 'level') defaults.level = (ctx.levelNow() || 1) + 1;
		if (verb === 'train') defaults.classTrain = true;
		if (!sc.positional.length) {
			stepOp({ op: 'insertGoal', step: vstep.index, index, fields: defaults }, `Add ${verb}`).then((r) => r && r.select && selectGoal(r.select.line)).catch(() => {});
			return;
		}
		const tmp = { fields: defaults, verb };
		const controls = [];
		const grid = h('div.gcard-body', { style: { padding: '0', minWidth: '300px' } });
		for (const f of sc.positional) {
			const c = fieldControl(f, defaults, { onChange: () => {}, focusKey: 'new' });
			controls.push(c);
			if (c.toggle) grid.append(h('div.toggles', c.el));
			else grid.append(h('label', f.label), c.el);
		}
		const err = h('div.gcard-err');
		const ok = h('button.btn.primary', { type: 'button' }, `Add ${verbMeta(verb).label}`);
		ok.addEventListener('click', () => {
			const fields = { ...tmp.fields };
			for (const c of controls) c.read(fields);
			for (const k of Object.keys(fields)) if (fields[k] === undefined) delete fields[k];
			ctx.apply([{ op: 'insertGoal', step: vstep.index, index, fields }], `Add ${verb}`)
				.then((r) => {
					closePopover();
					if (r && r.select) selectGoal(r.select.line);
				})
				.catch((e) => {
					// stale: the form's step and index came from the old view
					if (e.code !== 'stale') return (err.textContent = e.message);
					closePopover();
					toast(e.message, 'error');
				});
		});
		popover(h('div', h('div.pop-title', `New ${verbMeta(verb).label} goal`), grid, err, h('div.pop-foot', ok)), anchor, { align: 'right' });
		const first = grid.querySelector('input, select');
		if (first) first.focus();
	}

	function newStep(anchor) {
		const { vstep } = shown;
		const inp = h('input', { type: 'text', placeholder: 'Step title', style: { width: '260px' } });
		// A step needs a goal: it starts with a goto at the map centre.
		const go = () => {
			const title = inp.value.trim() || 'New step';
			closePopover();
			ctx.insertStep(vstep.index + 1, title).catch((e) => toast(e.message, 'error'));
		};
		inp.addEventListener('keydown', (e) => e.key === 'Enter' && go());
		popover(h('div', h('div.pop-title', 'New step'), h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, inp, h('button.btn.primary', { onclick: go }, 'Insert step'))), anchor, { align: 'right' });
		inp.focus();
	}

	return {
		el,
		// view: GuideView; vstep: its step; tlStep: the timeline step index.
		show(view, vstep, tlStep) {
			const same = shown && shown.view && view && shown.view.id === view.id && shown.vstep && vstep && shown.vstep.line === vstep.line;
			if (!same) {
				opened = true;
				extras.clear();
				errors.clear();
			}
			const sameText = same && shown.view.hash === view.hash && stepNum;
			shown = { view, vstep, tlStep };
			if (!sameText) return render();
			// The same source (a diagnostics or timeline update): the inputs stay.
			stepNum.textContent = stepLabel();
			renderDiags();
		},
		selectGoal,
	};
}
