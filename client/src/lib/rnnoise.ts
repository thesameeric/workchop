// RNNoise for "Enhanced" noise suppression, loaded only when someone turns it on.
export { loadRnnoise, RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor';
export { default as workletUrl } from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
export { default as wasmUrl } from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
export { default as simdUrl } from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';
