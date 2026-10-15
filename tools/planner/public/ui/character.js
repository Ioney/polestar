// The right panel in playback: the character at the current time (level,
// XP, hearthstone, bind, quest log with objectives, items, flight paths).
// Built once; update() rewrites only what changed.
import { h, clear, fmtClock, fmtInt, gameIcon, glyph } from './dom.js';
import { S } from './state.js';

const CLASS_NAMES = { WARRIOR: 'Warrior', PALADIN: 'Paladin', HUNTER: 'Hunter', ROGUE: 'Rogue', PRIEST: 'Priest', SHAMAN: 'Shaman', MAGE: 'Mage', WARLOCK: 'Warlock', DRUID: 'Druid' };
export const className = (c) => CLASS_NAMES[c] || c;
export const raceName = (r) => {
	const n = S.info && S.info.raceNames && S.info.raceNames[r];
	if (n && n !== r) return n;
	return r === 'Scourge' ? 'Undead' : r === 'NightElf' ? 'Night Elf' : r;
};

// The character's class and race icons (the game's own), with glyph fallbacks.
export function classIcon(cls, size = 's16') {
	return gameIcon({ kind: 'class', key: cls }, 'character', { size, title: className(cls) });
}
export function raceIcon(race, size = 's16') {
	return gameIcon({ kind: 'race', key: `${race}-male` }, 'character', { size, title: raceName(race) });
}

export function characterPanel(root) {
	const lvl = h('span.lvl');
	const xp = h('span.xp');
	const bar = h('i');
	const hearth = h('span.v');
	const qcount = h('span.v');
	const bind = h('span.v.place');
	const travel = h('span.v');
	const qlog = h('div.qlog');
	const items = h('div.items');
	const itn = h('span.count');
	const fps = h('div.fps');
	const fpn = h('span.count');
	const meta = h('div.char-meta');
	const sec = (title, count, body, open = true) => h('details.sec', { open }, h('summary', title, count, glyph('chevron-down', 'chev')), body);
	const el = h('div', { style: { display: 'contents' } },
		h('div.panel-head', h('h2', 'Character')),
		h('div.side-body',
			h('div.lvl-row', lvl, xp),
			h('div.xpbar', { title: 'Experience to the next level' }, bar),
			h('div.facts',
				h('div.fact', h('span.k', 'Hearthstone'), hearth),
				h('div.fact', h('span.k', 'Bind'), bind),
				h('div.fact', h('span.k', 'Quest log'), qcount),
				h('div.fact', h('span.k', 'Travel'), travel)),
			sec('In the log', null, qlog),
			sec('Quest items', itn, items),
			sec('Flight paths', fpn, fps, false),
			meta));
	root.append(el);

	let lastKey = '';
	let lastQuests = null;
	return {
		el,
		update(st, t, stepIdx) {
			lvl.textContent = `Level ${st.level}`;
			const pct = st.xpMax ? Math.floor((st.xp / st.xpMax) * 100) : 0;
			xp.textContent = st.xpMax ? `${fmtInt(st.xp)} / ${fmtInt(st.xpMax)} XP · ${pct}%` : 'Max level';
			bar.style.transform = `scaleX(${st.xpMax ? Math.min(1, st.xp / st.xpMax) : 1})`;
			if (st.hearthReady || st.hearthAt == null) {
				hearth.textContent = 'Ready';
				hearth.classList.remove('warn');
			} else {
				hearth.textContent = `In ${fmtClock(st.hearthAt - t)}`;
				hearth.classList.add('warn');
			}
			qcount.textContent = `${st.log.length} / 20`;
			bind.textContent = st.bind ? st.bind.name : 'None';
			bind.classList.toggle('none', !st.bind);
			travel.textContent = st.mounted ? 'Mounted' : 'On foot';
			const tl = S.timeline;
			const step = tl ? tl.steps[stepIdx] : null;
			meta.textContent = tl ? `Played ${fmtClock(t)} of ${fmtClock(tl.totals.seconds)} · step ${stepIdx + 1} of ${tl.steps.length}${step && step.estimate ? ' · estimate' : ''}` : '';

			const key = JSON.stringify([st.log, st.items, st.fps]);
			if (key === lastKey) return;
			lastKey = key;
			// Quests that are new or whose objectives moved since the last draw flash once.
			const prev = lastQuests;
			lastQuests = new Map(st.log.map((q) => [q.id, JSON.stringify(q)]));
			const flash = (q) => prev && prev.get(q.id) !== lastQuests.get(q.id);
			clear(qlog);
			if (!st.log.length) qlog.append(h('div.empty', 'No quests in the log.'));
			for (const q of st.log) {
				// One row: the game's marker, the name, Ready or the counter;
				// the objectives under it while the quest is unfinished.
				const os = q.objectives;
				const single = os.length === 1;
				const state = q.ready
					? h('span.st.ready', 'Ready')
					: single ? h('span.st', `${os[0].cur}/${os[0].max}`)
						: os.length ? h('span.st', { title: 'Objectives done' }, `${os.filter((o) => o.cur >= o.max).length}/${os.length}`) : null;
				const head = h('div.qt', gameIcon({ kind: 'ui', key: q.ready ? 'quest-turnin' : 'quest-available' }, q.ready ? 'icon-turnin' : 'icon-accept', { size: 's16', tint: 'quest' }), h('span', { title: q.title }, q.title), state);
				const objs = q.ready || !os.length ? null : h('div.qo', os.map((o) => h('div', { class: o.cur >= o.max ? 'done' : '', title: o.text }, h('span', o.text), single ? null : h('span', `${o.cur}/${o.max}`))));
				qlog.append(h('div', { class: `q${flash(q) ? ' flash' : ''}` }, head, objs));
			}
			itn.textContent = st.items.length;
			clear(items);
			if (!st.items.length) items.append(h('div.empty', 'No quest items.'));
			for (const it of st.items) {
				items.append(h('div.irow',
					gameIcon(it.id != null ? { kind: 'item', key: String(it.id) } : null, 'icon-collect', { size: 's18', tint: 'item' }),
					h('span.n.c-item', { title: it.name }, it.name),
					h('span.c', `×${it.count}`)));
			}
			fpn.textContent = st.fps.length;
			clear(fps);
			if (!st.fps.length) fps.append(h('div.empty', 'No flight paths known.'));
			for (const f of st.fps) fps.append(h('div.irow', gameIcon({ kind: 'ui', key: 'flightmaster' }, 'icon-getfp', { size: 's16', tint: 'spell' }), h('span.n.c-place', f)));
		},
	};
}
