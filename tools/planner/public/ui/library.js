// The Library, as the guide menu: every guide of the loaded packs, one line
// per guide (title and level range) grouped by pack, category and folder,
// with a search and a faction filter; choosing a row shows its details (the
// zone painting, chips, facts from the guide itself) and "Play this guide"
// makes it the route's start. Selecting is not loading.
import { cmd } from '../api.js';
import { h, clear, glyph } from './dom.js';
import { S } from './state.js';
import { className, raceName } from './character.js';
import { raceOptions } from './topbar.js';

let open = null;

export function closeLibrary() {
	if (!open) return false;
	open.remove();
	open = null;
	return true;
}

function who(g) {
	const parts = [];
	if (g.races && g.races.length) parts.push(g.races.map(raceName).join('/'));
	if (g.classes && g.classes.length) parts.push(g.classes.map(className).join('/'));
	return parts.join(' · ');
}

// Who guide g is for, as a short phrase ("Dwarf/Gnome", "Druid", "Horde").
export function guideAudience(g) {
	return who(g) || g.faction || '';
}

// Whether character ch can follow guide g (its faction, races and classes).
export function canFollow(g, ch) {
	if (g.faction && g.faction !== ch.faction) return false;
	if (g.races && g.races.length && !g.races.includes(ch.race)) return false;
	if (g.classes && g.classes.length && !g.classes.includes(ch.cls)) return false;
	return true;
}

// The character to play guide g with: ch when it can follow g, else the
// first race of the guide that fits (the current race first when the guide
// allows it), keeping the class when that race can be it, else the race's
// first class the guide allows. Null when no race and class fit.
export function characterFor(g, ch) {
	if (canFollow(g, ch)) return ch;
	const opts = raceOptions().filter((o) => !g.faction || o.faction === g.faction);
	const races = g.races && g.races.length ? g.races : opts.map((o) => o.race);
	const order = races.includes(ch.race) ? [ch.race, ...races.filter((r) => r !== ch.race)] : races;
	const allowed = (c) => !g.classes || !g.classes.length || g.classes.includes(c);
	for (const race of order) {
		const o = opts.find((x) => x.race === race);
		if (!o) continue;
		const cls = o.classes.includes(ch.cls) && allowed(ch.cls) ? ch.cls : o.classes.find(allowed);
		if (cls) return { race: o.race, cls, faction: o.faction };
	}
	return null;
}

// The art index's zones by name (for a guide's painting), fetched once.
let zonesByName = null;
async function zoneArtId(g) {
	if (g.map != null) return g.map;
	if (!zonesByName) {
		zonesByName = new Map();
		try {
			const res = await fetch('/art/index.json');
			const idx = res.ok ? await res.json() : null;
			for (const [id, z] of Object.entries((idx && idx.zones) || {})) if (z && z.name) zonesByName.set(z.name.toLowerCase(), id);
		} catch {
			// no art: the band stands in
		}
	}
	return g.zone ? zonesByName.get(String(g.zone).toLowerCase()) ?? null : null;
}

// Facts read from the guide itself (GuideView), fetched once per guide.
const facts = new Map();
function guideFacts(id) {
	if (!facts.has(id)) {
		facts.set(id, cmd('guide_get', { id }).then((v) => {
			const quests = new Set();
			for (const st of v.steps) for (const g of st.goals) if (g.verb === 'accept' && g.fields && g.fields.quest != null) quests.add(g.fields.quest);
			const z = v.steps.find((st) => st.zone) || null;
			const zone = z ? (typeof z.zone === 'string' ? z.zone : z.zone.name || '') : '';
			return { steps: v.steps.length, quests: quests.size, zone };
		}).catch(() => null));
	}
	return facts.get(id);
}

const lv = (g) => (g.levels ? `${g.levels.min}–${g.levels.max}` : '');

export function openLibrary(onPick) {
	closeLibrary();
	const search = h('input', { type: 'search', placeholder: 'Search guides by title, id or zone', 'aria-label': 'Search guides' });
	let faction = S.character.faction;
	let sel = S.start;
	const facBtns = ['All', 'Alliance', 'Horde'].map((f) => h('button', {
		class: (f === 'All' ? null : f) === faction || (f === 'All' && !faction) ? 'on' : '',
		onclick: () => {
			faction = f === 'All' ? null : f;
			facBtns.forEach((b) => b.classList.toggle('on', b.textContent === f));
			draw();
		},
	}, f));
	const list = h('div.lib-list', { role: 'listbox', 'aria-label': 'Guides' });
	const detail = h('div.lib-detail');
	const panel = h('div.lib', { role: 'dialog', 'aria-label': 'Library' },
		h('div.lib-head',
			h('h2', 'Library'),
			h('div.search', glyph('search'), search),
			h('div.seg', facBtns),
			h('span.spacer'),
			h('button.btn.icon', { title: 'Close (Esc)', 'aria-label': 'Close', onclick: closeLibrary }, glyph('close'))),
		list, detail);
	const back = h('div.lib-back', panel);
	back.addEventListener('pointerdown', (e) => {
		if (e.target === back) closeLibrary();
	});
	search.addEventListener('input', () => draw());
	search.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') {
			const row = list.querySelector('.lib-guide.on') || list.querySelector('.lib-guide');
			if (row) play(row.dataset.id);
		} else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			const rows = [...list.querySelectorAll('.lib-guide')];
			const k = rows.findIndex((r) => r.dataset.id === sel);
			const next = rows[Math.max(0, Math.min(rows.length - 1, k + (e.key === 'ArrowDown' ? 1 : -1)))];
			if (next) select(next.dataset.id, true);
		}
	});

	// Continue (the current route) only closes: playback stays where it is.
	const play = (id) => {
		closeLibrary();
		if (id !== S.start) onPick(id);
	};

	function select(id, scroll = false) {
		sel = id;
		for (const r of list.querySelectorAll('.lib-guide')) {
			const on = r.dataset.id === id;
			r.classList.toggle('on', on);
			r.setAttribute('aria-selected', on ? 'true' : 'false');
			if (on && scroll) r.scrollIntoView({ block: 'nearest' });
		}
		showDetail(S.guideById.get(id));
	}

	let detailSeq = 0;
	function showDetail(g) {
		const seq = ++detailSeq;
		clear(detail);
		if (!g) {
			detail.append(h('div.lib-empty', 'Choose a guide to see what it covers.'));
			return;
		}
		const art = h('div.lib-art', h('div.band'), h('div.stars'), h('h3', g.title));
		zoneArtId(g).then((id) => {
			if (seq !== detailSeq || id == null) return;
			const img = h('img', { alt: '', src: `/art/zones/${id}.png` });
			img.addEventListener('load', () => {
				art.querySelector('.band').remove();
				art.querySelector('.stars').remove();
			}, { once: true });
			img.addEventListener('error', () => img.remove(), { once: true });
			art.prepend(img);
		});
		const chips = h('div.lib-chips');
		if (g.levels) chips.append(h('span.chip.accent', `Level ${lv(g)}`));
		chips.append(h('span.chip', g.faction || 'Both factions'));
		if ((g.races && g.races.length) || (g.classes && g.classes.length)) chips.append(h('span.chip', `${who(g)} only`));
		if (g.id === S.start) chips.append(h('span.chip.success', 'Your current route'));
		if (g.category) chips.append(h('span.chip', g.category));
		const steps = h('span.v', '…');
		const quests = h('span.v', '…');
		const zone = h('span.v.place', g.zone || '…');
		const nextIds = g.nextChoices && g.nextChoices.length ? g.nextChoices : g.next ? [g.next] : [];
		const next = nextIds.map((id) => (S.guideById.get(id) || {}).title || id).join(' or ') || 'None';
		const other = !canFollow(g, S.character);
		const playBtn = h('button.btn.primary', { onclick: () => play(g.id), title: g.id === S.start ? 'Back to the route where it is' : other ? `Plays as a character who can follow it (${guideAudience(g)})` : 'Start the route with this guide' }, glyph('play'), g.id === S.start ? 'Continue' : 'Play this guide');
		detail.append(art, h('div.lib-body',
			chips,
			h('div.facts',
				h('div.fact', h('span.k', 'Steps'), steps),
				h('div.fact', h('span.k', 'Quests taken'), quests),
				h('div.fact', h('span.k', 'First zone'), zone),
				h('div.fact', h('span.k', 'Next guide'), h('span.v', { title: next }, next)),
				h('div.fact', h('span.k', 'File'), h('span.v', { title: g.file }, g.file.split('/').pop()))),
			other ? h('p.lib-pitch', `This guide is for ${guideAudience(g)}: playing it switches the character to one who can follow it.`) : null,
			h('div.lib-foot', playBtn, h('button.btn', { onclick: closeLibrary }, 'Close'))));
		guideFacts(g.id).then((f) => {
			if (seq !== detailSeq) return;
			steps.textContent = f ? f.steps.toLocaleString('en-US') : 'Unknown';
			quests.textContent = f ? f.quests.toLocaleString('en-US') : 'Unknown';
			if (f && f.zone) zone.textContent = f.zone;
			else if (!g.zone) zone.textContent = 'Unknown';
		});
	}

	function draw() {
		const q = search.value.trim().toLowerCase();
		const shown = S.guides.filter((g) => {
			if (faction && g.faction && g.faction !== faction) return false;
			if (!q) return true;
			return `${g.title} ${g.id} ${g.zone || ''} ${g.folder || ''}`.toLowerCase().includes(q);
		});
		clear(list);
		if (!shown.length) {
			list.append(h('div.lib-empty', q ? `No guide matches “${search.value.trim()}”.` : 'No guide for this faction.'));
			return;
		}
		const packs = S.info.packs.filter((p) => shown.some((g) => g.pack === p.id));
		for (const p of packs) {
			const mine = shown.filter((g) => g.pack === p.id);
			if (packs.length > 1) list.append(h('div.lib-pack', p.title || p.id));
			const groups = new Map();
			for (const g of mine) {
				const key = g.folder ? `${g.category || 'Leveling'} · ${g.folder}` : g.category || 'Leveling';
				if (!groups.has(key)) groups.set(key, []);
				groups.get(key).push(g);
			}
			for (const [name, guides] of groups) {
				const follow = guides.some((g) => canFollow(g, S.character));
				list.append(h('div', { class: `lib-folder${follow ? '' : ' fade'}` }, name, h('span.count', String(guides.length))));
				for (const g of guides) {
					const other = !canFollow(g, S.character);
					list.append(h('button', {
						class: `lib-guide${g.id === sel ? ' on' : ''}${g.id === S.start ? ' cur' : ''}${other ? ' other' : ''}`,
						role: 'option',
						'aria-selected': g.id === sel ? 'true' : 'false',
						'data-id': g.id,
						title: `${g.id}${other ? ` · for ${guideAudience(g)}` : ''} · double-click to play`,
						onclick: () => select(g.id),
						ondblclick: () => play(g.id),
					}, h('span.t', g.title), h('span.lv', lv(g))));
				}
			}
		}
		const on = list.querySelector('.lib-guide.on');
		if (on && !q) on.scrollIntoView({ block: 'center' });
	}

	document.body.append(back);
	open = back;
	draw();
	showDetail(S.guideById.get(sel));
	search.focus();
}
