// WebGL2 helpers for the map renderer: shader programs (uniform locations
// collected by name), instanced buffers, CSS colour parsing, the plane
// conversions shared by every layer.

export const ADT = 1600 / 3;

// Compile and link a program; uniforms are collected into `u` by name
// (array uniforms under their base name).
export function program(gl, vs, fs) {
	const shader = (type, src) => {
		const s = gl.createShader(type);
		gl.shaderSource(s, src);
		gl.compileShader(s);
		if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
			const log = gl.getShaderInfoLog(s);
			gl.deleteShader(s);
			throw new Error(`map shader: ${log}`);
		}
		return s;
	};
	const prog = gl.createProgram();
	const v = shader(gl.VERTEX_SHADER, vs), f = shader(gl.FRAGMENT_SHADER, fs);
	gl.attachShader(prog, v);
	gl.attachShader(prog, f);
	gl.linkProgram(prog);
	gl.deleteShader(v);
	gl.deleteShader(f);
	if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`map program: ${gl.getProgramInfoLog(prog)}`);
	const u = {};
	const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
	for (let i = 0; i < n; i++) {
		const info = gl.getActiveUniform(prog, i);
		const name = info.name.replace(/\[0\]$/, '');
		u[name] = gl.getUniformLocation(prog, info.name);
	}
	return { prog, u };
}

// A VAO over one dynamic instance buffer. `layout` is [[location, size], ...]
// in float units; every attribute advances once per instance.
export class Instances {
	constructor(gl, layout) {
		this.gl = gl;
		this.stride = layout.reduce((s, [, n]) => s + n, 0);
		this.vao = gl.createVertexArray();
		this.buf = gl.createBuffer();
		this.count = 0;
		this.capacity = 0;
		gl.bindVertexArray(this.vao);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
		let off = 0;
		for (const [loc, size] of layout) {
			gl.enableVertexAttribArray(loc);
			gl.vertexAttribPointer(loc, size, gl.FLOAT, false, this.stride * 4, off * 4);
			gl.vertexAttribDivisor(loc, 1);
			off += size;
		}
		gl.bindVertexArray(null);
	}

	// data: Float32Array of count * stride floats (may be longer).
	set(data, count) {
		const gl = this.gl;
		this.count = count;
		gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
		const n = count * this.stride;
		if (n > this.capacity) {
			this.capacity = Math.max(n, Math.ceil(this.capacity * 1.5));
			gl.bufferData(gl.ARRAY_BUFFER, this.capacity * 4, gl.DYNAMIC_DRAW);
		}
		if (n) gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, n);
	}

	// Draw every instance as a 4-vertex strip.
	draw() {
		if (!this.count) return;
		const gl = this.gl;
		gl.bindVertexArray(this.vao);
		gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
		gl.bindVertexArray(null);
	}

	dispose() {
		this.gl.deleteBuffer(this.buf);
		this.gl.deleteVertexArray(this.vao);
	}
}

// Any CSS colour -> [r, g, b, a] in 0..1 (straight alpha).
let probe = null;
export function parseColor(css, fallback) {
	if (!css || !css.trim()) return parseColor(fallback);
	probe ||= new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
	probe.clearRect(0, 0, 1, 1);
	probe.fillStyle = '#000';
	probe.fillStyle = css.trim();
	probe.fillRect(0, 0, 1, 1);
	const d = probe.getImageData(0, 0, 1, 1).data;
	if (d[3] === 0) return fallback ? parseColor(fallback) : [0, 0, 0, 0];
	return [d[0] / 255, d[1] / 255, d[2] / 255, d[3] / 255];
}

export const cssOf = (c) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${c[3]})`;
