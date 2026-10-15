'use strict';
// The terrain pyramid's per-tile work, run in a worker thread (or inline):
//
//   { op: 'block', blp, file, sea, half }  a native minimap block (cached BLP path):
//                                          decode, write its tile (level 0 = its own DXT1)
//   { op: 'tile', rgba, file, half }       a 512 x 512 RGBA image: write its tile
//   { op: 'file', file }                   an existing tile: decode its level 0
//
// Each answers { half } (the 256 x 256 RGBA box downsample a parent tile
// needs; omitted when `half` is false). Files are written gzip'd via a
// temporary name, so a present file is always whole.

const fs = require('node:fs');
const zlib = require('node:zlib');
const { isMainThread, parentPort } = require('node:worker_threads');
const { readBlp, decodeMip } = require('./blp');
const { mipChainBC1, decodeBC1, downsample2, bc1Size, TILE } = require('./bc1');

// Box halving while the image is at least twice the target, then
// nearest-neighbour resample to W x H.
function resize(rgba, w, h, W, H) {
	while (w >= 2 * W && h >= 2 * H && w % 2 === 0 && h % 2 === 0) {
		rgba = downsample2(rgba, w, h);
		w >>= 1;
		h >>= 1;
	}
	if (w === W && h === H) return rgba;
	const out = new Uint8Array(W * H * 4);
	for (let y = 0; y < H; y++) {
		const sy = Math.min(h - 1, Math.floor(((y + 0.5) * h) / H));
		for (let x = 0; x < W; x++) {
			const sx = Math.min(w - 1, Math.floor(((x + 0.5) * w) / W));
			out.set(rgba.subarray((sy * w + sx) * 4, (sy * w + sx) * 4 + 4), (y * W + x) * 4);
		}
	}
	return out;
}

function writeTile(file, chain) {
	const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	fs.writeFileSync(tmp, zlib.gzipSync(chain, { level: 9 }));
	fs.renameSync(tmp, file);
}

function runJob(job) {
	let rgba;
	if (job.op === 'block') {
		const blp = readBlp(fs.readFileSync(job.blp));
		rgba = resize(decodeMip(blp, 0), blp.width, blp.height, TILE, TILE);
		const own = blp.format === 'dxt1' && blp.alphaDepth === 0 && blp.width === TILE && blp.height === TILE;
		if (!own) {
			// Anything translucent sits on the sea.
			const [sr, sg, sb] = job.sea;
			for (let i = 0; i < rgba.length; i += 4) {
				const a = rgba[i + 3];
				if (a === 255) continue;
				rgba[i] = (rgba[i] * a + sr * (255 - a) + 127) / 255;
				rgba[i + 1] = (rgba[i + 1] * a + sg * (255 - a) + 127) / 255;
				rgba[i + 2] = (rgba[i + 2] * a + sb * (255 - a) + 127) / 255;
				rgba[i + 3] = 255;
			}
		}
		writeTile(job.file, mipChainBC1(rgba, own ? blp.mips[0].raw : null));
	} else if (job.op === 'tile') {
		rgba = job.rgba;
		writeTile(job.file, mipChainBC1(rgba, null));
	} else if (job.op === 'file') {
		rgba = decodeBC1(zlib.gunzipSync(fs.readFileSync(job.file)).subarray(0, bc1Size(TILE, TILE)), TILE, TILE, { opaque: true });
	} else throw new Error(`art worker: unknown op ${job.op}`);
	return job.half === false ? {} : { half: downsample2(rgba, TILE, TILE) };
}

if (!isMainThread && parentPort) {
	parentPort.on('message', ({ job }) => {
		try {
			const out = runJob(job);
			parentPort.postMessage({ out }, out.half ? [out.half.buffer] : []);
		} catch (err) {
			parentPort.postMessage({ error: err.message });
		}
	});
}

module.exports = { runJob, resize };
