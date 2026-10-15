// The find popover: looks ids up by name with the `find` command (filtered
// by kind and the character's faction) and hands the picked result back.
import { cmd } from '../api.js';
import { h, clear, glyph, popover, closePopover, debounce } from './dom.js';
import { S } from './state.js';

const FIND_KINDS = new Set(['quest', 'npc', 'object', 'item', 'inn', 'flight', 'guide']);

function context(r) {
	const parts = [];
	if (r.level) parts.push(`level ${r.level}`);
	if (r.zone) parts.push(r.x != null ? `${r.zone} ${Number(r.x).toFixed(1)}, ${Number(r.y).toFixed(1)}` : r.zone);
	else if (r.x != null) parts.push(`${Number(r.x).toFixed(1)}, ${Number(r.y).toFixed(1)}`);
	if (r.start && r.start.name) parts.push(`from ${r.start.name}`);
	if (r.npcName) parts.push(r.npcName);
	return parts.join(' · ');
}

// Opens under `anchor`; onPick(result) when a row is chosen.
export function findPopover(anchor, { kind, text = '', onPick }) {
	const input = h('input', { type: 'search', placeholder: kind ? `Find ${kind} by name or id…` : 'Find by name or id…', value: text });
	const list = h('div.find-list');
	let results = [];
	let active = 0;
	let seq = 0;

	const draw = () => {
		clear(list);
		if (!results.length) {
			list.append(h('div.find-empty', input.value.trim() ? 'No matches.' : 'Type a name or an id.'));
			return;
		}
		results.forEach((r, k) => {
			list.append(h('div', { class: `find-row${k === active ? ' active' : ''}`, onmousedown: (e) => { e.preventDefault(); pick(r); } },
				h('span', { class: `n ${r.kind || ''}` }, r.name),
				h('span.id', `${r.kind} ${r.id}`),
				h('span.ctx', context(r) || '\u00a0')));
		});
	};
	const pick = (r) => {
		closePopover();
		onPick(r);
	};
	const search = debounce(async () => {
		const q = input.value.trim();
		const mine = ++seq;
		if (!q) {
			results = [];
			draw();
			return;
		}
		try {
			const args = { text: q, limit: 15, faction: S.character.faction };
			if (kind && FIND_KINDS.has(kind)) args.kind = kind;
			const res = await cmd('find', args);
			if (mine !== seq) return;
			results = (Array.isArray(res) ? res : res.results || []).filter((r) => !kind || !FIND_KINDS.has(kind) || r.kind === kind);
			active = 0;
			draw();
		} catch (e) {
			if (mine !== seq) return;
			results = [];
			clear(list).append(h('div.find-empty', e.message));
		}
	}, 140);
	input.addEventListener('input', search);
	input.addEventListener('keydown', (e) => {
		if (e.key === 'ArrowDown') active = Math.min(results.length - 1, active + 1);
		else if (e.key === 'ArrowUp') active = Math.max(0, active - 1);
		else if (e.key === 'Enter' && results[active]) return pick(results[active]);
		else if (e.key === 'Escape') {
			// only this list: a form it was opened from stays open
			e.stopPropagation();
			return closePopover();
		} else return;
		e.preventDefault();
		draw();
	});
	popover(h('div', h('div.search', glyph('search'), input), list), anchor, { cls: 'find-pop' });
	draw();
	input.focus();
	if (text) search();
}
