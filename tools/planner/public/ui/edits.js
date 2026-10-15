// Source edits: every edit names the guide's current hash. A stale hash (the
// file changed under the page) reloads the guide and refuses the edit: its
// lines came from the old view and may name other goals now.
// Edits run one at a time so each sees the hash the previous one produced.
import { cmd, ApiError } from '../api.js';
import { S, emit } from './state.js';

let chain = Promise.resolve();
function serial(fn) {
	const p = chain.then(fn, fn);
	chain = p.catch(() => {});
	return p;
}

export async function loadGuide(id) {
	const view = await cmd('guide_get', { id });
	S.views.set(id, view);
	emit('guide', view);
	return view;
}

async function withHash(id, run) {
	const view = S.views.get(id) || (await loadGuide(id));
	try {
		return await run(view.hash);
	} catch (e) {
		if (e.code !== 'stale') throw e;
		await loadGuide(id);
		throw new ApiError('The guide changed on disk; edit again', 'stale');
	}
}

function landed(guide, select) {
	S.views.set(guide.id, guide);
	emit('guide', guide);
	emit('edited', { id: guide.id, select: select || null });
}

// ops: source.js operations on guide `id` -> { guide, select }
export function apply(id, ops, label) {
	return serial(async () => {
		const r = await withHash(id, (hash) => cmd('edit_apply', { id, hash, ops, label }));
		landed(r.guide, r.select);
		return r;
	});
}

// Moves goal `line` of guide `id` to a world point.
export function moveWorld(id, line, c, wx, wy) {
	return serial(async () => {
		const r = await withHash(id, (hash) => cmd('edit_move_world', { id, hash, line, c, wx, wy }));
		landed(r.guide, r.select);
		return r;
	});
}

// Inserts a goto/explore at a world point in one edit: into step `step` at
// goal position `index` (labelled `text` when given), or with `title` as a
// new step at position `step`.
export function insertWorld(id, { step, index, title, verb = 'goto', text, c, wx, wy }) {
	return serial(async () => {
		const args = { step, verb, c, wx, wy };
		if (text) args.text = text;
		if (title !== undefined) args.title = title;
		else args.index = index;
		const r = await withHash(id, (hash) => cmd('edit_insert_world', { id, hash, ...args }));
		landed(r.guide, r.select);
		return r;
	});
}

// drop: remove a conflicting top entry instead of applying it.
export function undo(drop = false) {
	return serial(async () => {
		const r = await cmd('edit_undo', drop ? { drop: true } : {});
		if (r && r.guide) landed(r.guide, null);
		return r;
	});
}

export function redo(drop = false) {
	return serial(async () => {
		const r = await cmd('edit_redo', drop ? { drop: true } : {});
		if (r && r.guide) landed(r.guide, null);
		return r;
	});
}
