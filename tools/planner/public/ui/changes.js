// The Changes drawer: guide files the planner changed since it started
// (revert per file), and the last lint run (click a diagnostic to go there).
import { cmd } from '../api.js';
import { h, clear, glyph } from './dom.js';
import { S, emit, currentPack } from './state.js';
import { toast } from './toasts.js';

export function changesDrawer(ctx) {
	const list = h('div');
	const lintEl = h('div');
	const lintBtn = h('button.btn.small', { title: 'Full compile check of the pack' }, 'Run lint');
	const drawer = h('aside.drawer', { 'aria-label': 'Changes' },
		h('div.panel-head', h('h2', 'Changes'), h('span.spacer'), h('button.btn.small.icon', { title: 'Close (Esc)', 'aria-label': 'Close', onclick: () => api.close() }, glyph('close'))),
		h('div.drawer-body',
			list,
			h('div.ed-sec', 'Lint', h('span.spacer'), lintBtn),
			lintEl));
	document.body.append(drawer);

	async function refresh() {
		try {
			S.changes = await cmd('changes_list', {});
		} catch (e) {
			toast(e.message, 'error');
			return;
		}
		emit('changes', S.changes);
		draw();
	}

	function draw() {
		clear(list);
		if (!S.changes.length) {
			list.append(h('div.empty', { style: { paddingTop: '12px' } }, 'No guide file differs from its text when the planner started.'));
			return;
		}
		for (const c of S.changes) {
			list.append(h('div.chg',
				h('span.f', { title: c.file }, c.file),
				h('span.add', `+${c.added}`),
				h('span.rem', `−${c.removed}`),
				h('button.btn.small', {
					title: 'Write the file back to its text when the planner started (undoable)',
					onclick: async () => {
						if (!confirm(`Revert ${c.file} to its text when the planner started?`)) return;
						try {
							const r = await cmd('changes_revert', { file: c.file });
							if (r && r.guide) {
								S.views.set(r.guide.id, r.guide);
								emit('guide', r.guide);
								emit('edited', { id: r.guide.id, select: null });
							}
							toast(`Reverted ${c.file}`, 'ok');
						} catch (e) {
							toast(e.message, 'error');
						}
						refresh();
					},
				}, glyph('reset'), 'Revert')));
		}
	}

	function drawLint() {
		clear(lintEl);
		if (!S.lint) {
			lintEl.append(h('div.empty', 'Not run yet.'));
			return;
		}
		if (!S.lint.length) {
			lintEl.append(h('div.empty', 'No errors or warnings.'));
			return;
		}
		const byFile = new Map();
		for (const d of S.lint) {
			if (!byFile.has(d.file)) byFile.set(d.file, []);
			byFile.get(d.file).push(d);
		}
		for (const [file, ds] of byFile) {
			lintEl.append(h('div.lint-file', file));
			lintEl.append(h('div.diags', ds.map((d) => h('div', { class: `diag ${d.severity}`, onclick: () => ctx.focusFileLine(file, d.line) },
				glyph(d.severity === 'info' ? 'info' : 'warning'), h('span.ln', String(d.line || '')), h('span', d.message), d.hint ? h('span.hint', d.hint) : null))));
		}
	}

	lintBtn.addEventListener('click', async () => {
		lintBtn.disabled = true;
		lintBtn.textContent = 'Linting…';
		try {
			S.lint = await cmd('lint', { pack: currentPack() });
			const errs = S.lint.filter((d) => d.severity === 'error').length;
			toast(`Lint: ${errs} errors, ${S.lint.length - errs} warnings`, errs ? 'error' : S.lint.length ? 'warn' : 'ok');
			emit('lint', S.lint);
		} catch (e) {
			toast(e.message, 'error');
		}
		lintBtn.disabled = false;
		lintBtn.textContent = 'Run lint';
		drawLint();
	});

	const api = {
		refresh,
		isOpen: () => drawer.classList.contains('open'),
		open() {
			drawer.classList.add('open');
			draw();
			drawLint();
			refresh();
		},
		close() {
			if (!drawer.classList.contains('open')) return false;
			drawer.classList.remove('open');
			return true;
		},
		toggle() {
			if (api.isOpen()) api.close();
			else api.open();
		},
	};
	return api;
}
