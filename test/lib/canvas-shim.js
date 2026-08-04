// A 2D context good enough to exercise layout, for a DOM that has none.
//
// jsdom implements no canvas backend, and the native `canvas` package needs
// cairo and a toolchain that CI machines and this laptop do not have. Without
// something here the PDF suites cannot run at all -- which is how they came to
// be red for a long time while nobody could see what they were failing on.
//
// What this shim gives you is real geometry and no pixels: measureText returns
// a width proportional to the string and the font size, so wrapping, page
// breaks and the notation grid all behave as they do in a browser, and every
// drawing call is recorded rather than rasterised. toDataURL hands back a
// tiny valid JPEG so the PDF writer has bytes to embed.
//
// It therefore tests the layout, not the rendering. A glyph landing in the
// wrong place on screen is out of its reach; a page break in the wrong place
// is not.

// Smallest JPEG that decoders accept, as base64.
const STUB_JPEG =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

function parseFontPx(font) {
  const m = /(\d+(?:\.\d+)?)px/.exec(font || '');
  return m ? parseFloat(m[1]) : 10;
}

function makeContext(canvas) {
  const calls = [];
  const noop = (name) => (...args) => { calls.push([name, ...args]); };
  const ctx = {
    canvas,
    calls,
    font: '10px sans-serif',
    fillStyle: '#000', strokeStyle: '#000',
    lineWidth: 1, lineCap: 'butt', lineJoin: 'miter',
    textAlign: 'start', textBaseline: 'alphabetic',
    globalAlpha: 1, globalCompositeOperation: 'source-over',
    miterLimit: 10, lineDashOffset: 0, imageSmoothingEnabled: true,
    shadowBlur: 0, shadowColor: 'transparent',
    shadowOffsetX: 0, shadowOffsetY: 0,

    // The only method whose return value the layout code actually reads.
    measureText(t) {
      const px = parseFontPx(ctx.font);
      const mono = /Menlo|Consolas|DejaVu Sans Mono|monospace/i.test(ctx.font);
      const per = px * (mono ? 0.6 : 0.5);
      const s = String(t == null ? '' : t);
      return {
        width: s.length * per,
        actualBoundingBoxAscent: px * 0.75,
        actualBoundingBoxDescent: px * 0.25,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: s.length * per,
      };
    },
    getImageData(x, y, w, h) {
      return { data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h };
    },
    createImageData(w, h) {
      return { data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h };
    },
    createLinearGradient() { return { addColorStop() {} }; },
    createRadialGradient() { return { addColorStop() {} }; },
    createPattern() { return null; },
    getLineDash() { return []; },
    isPointInPath() { return false; },
  };
  [
    'save', 'restore', 'scale', 'rotate', 'translate', 'transform', 'setTransform',
    'resetTransform', 'clearRect', 'fillRect', 'strokeRect', 'beginPath',
    'closePath', 'moveTo', 'lineTo', 'bezierCurveTo', 'quadraticCurveTo', 'arc',
    'arcTo', 'ellipse', 'rect', 'fill', 'stroke', 'clip', 'fillText', 'strokeText',
    'drawImage', 'putImageData', 'setLineDash',
  ].forEach((m) => { ctx[m] = noop(m); });
  return ctx;
}

/** Install on a jsdom window, before its scripts run. */
function install(window) {
  const proto = window.HTMLCanvasElement.prototype;
  proto.getContext = function (kind) {
    if (kind && String(kind).indexOf('2d') !== 0) return null;
    if (!this.__ctx) this.__ctx = makeContext(this);
    return this.__ctx;
  };
  proto.toDataURL = function (type) {
    return (String(type || 'image/png').indexOf('jpeg') !== -1)
      ? 'data:image/jpeg;base64,' + STUB_JPEG
      : 'data:image/png;base64,' +
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  };
  proto.toBlob = function (cb, type) {
    const url = this.toDataURL(type);
    const bin = Buffer.from(url.split(',')[1], 'base64');
    cb(new window.Blob([bin], { type: type || 'image/png' }));
  };
  return window;
}

module.exports = { install, makeContext, STUB_JPEG };
