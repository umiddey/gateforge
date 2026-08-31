/**
 * Type declaration for the shipped sample adapter. The .mjs file is
 * dynamically loaded by the witness; for static type checking in the
 * test suite, we declare its default export here.
 */
declare const sample: import('../src/adapter-schema.js').AuthEntityAdapter;
export default sample;
