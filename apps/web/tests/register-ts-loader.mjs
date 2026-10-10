import { register } from 'node:module';

// The shared package keeps `.js` specifiers so emitted JavaScript is valid. The web unit tests
// execute TypeScript source directly with Node's type stripper, so teach only this test process
// to resolve a missing source `.js` file to its adjacent `.ts` file.
register('./ts-source-loader.mjs', import.meta.url);
