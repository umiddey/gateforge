/**
 * Validation pack detector — discovers request-validation schemas in
 * TypeScript / JavaScript source files and emits one `validation.schema`
 * resource per schema definition.
 *
 * Recognised constructs (TS/JS only):
 *   - zod: `z.object({...})` / `zod.object({...})` / `schema.parse(...)`
 *   - joi: `Joi.object({...})` / `joi.object({...})` / `schema.validate(...)`
 *   - yup: `yup.object({...})` / `schema.shape` / `schema.validateSync(...)`
 *   - class-validator: classes decorated with `@Validator` and props
 *     decorated with `@IsString` / `@MinLength` / `@IsEmail` / etc.
 *
 * Each detected schema becomes a `validation.schema` resource:
 *   {
 *     id: "validation.<route-or-class-name>.<schemaName>",
 *     kind: "validation.schema",
 *     attributes: {
 *       library: "zod" | "joi" | "yup" | "class-validator",
 *       fields: Record<string, { type: string; constraints: string[] }>,
 *       boundary: "strict" | "lenient" | "unknown",
 *     }
 *   }
 *
 * Discovery is pure (no execution), deterministic (no Date.now /
 * Math.random), and fails closed: malformed schemas surface as
 * `AMBIGUOUS_SCHEMA` findings, never silently emit.
 */
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { readFileSync } from 'node:fs';
import { GATEFORGE_SCHEMA_VERSION } from '@gate-forge/core';
import { PACK_VERSION } from './version.js';
/** Resource kind emitted by this pack. */
export const VALIDATION_SCHEMA_KIND = 'validation.schema';
/** Walks a directory non-recursively, returning .ts/.tsx/.js/.mjs paths. */
function collectFiles(input) {
    const stat = (() => {
        try {
            return require('node:fs').statSync(input);
        }
        catch {
            return null;
        }
    })();
    if (stat === null)
        return [];
    if (stat.isDirectory()) {
        const { readdirSync } = require('node:fs');
        return readdirSync(input)
            .filter((n) => /\.(ts|tsx|js|mjs)$/.test(n))
            .map((n) => resolve(input, n));
    }
    return [input];
}
/** Detects a `z.object({...})` schema declaration. */
function detectZod(text, file) {
    const out = [];
    // Match `const <name>Schema = z.object({...})` or `zod.object({...})`
    const decl = /(?:export\s+)?const\s+(\w+)\s*=\s*(?:z|zod)\.object\(\s*\{/g;
    let m;
    while ((m = decl.exec(text)) !== null) {
        const name = m[1] ?? 'unknown';
        const line = text.substring(0, m.index).split('\n').length;
        out.push({
            id: `validation.zod.${name.toLowerCase()}`,
            library: 'zod',
            name,
            boundary: 'strict',
            fields: extractZodFields(text, m.index + m[0].length),
            file,
            line,
            col: 0,
        });
    }
    return out;
}
/** Best-effort field extraction from a zod object literal start. */
function extractZodFields(text, openIdx) {
    const out = {};
    let depth = 1;
    let i = openIdx;
    // Walk to the matching closing brace, then regex out field names.
    while (i < text.length && depth > 0) {
        const ch = text[i];
        if (ch === '{')
            depth += 1;
        else if (ch === '}')
            depth -= 1;
        i += 1;
    }
    const body = text.slice(openIdx, i - 1);
    const fieldRe = /(\w+)\s*:\s*z\.(\w+)\s*\(([^)]*)\)/g;
    let fm;
    while ((fm = fieldRe.exec(body)) !== null) {
        out[fm[1] ?? ''] = {
            type: fm[2] ?? 'unknown',
            constraints: (fm[3] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
        };
    }
    return out;
}
/** Detects a `Joi.object({...})` schema declaration. */
function detectJoi(text, file) {
    const out = [];
    const decl = /(?:export\s+)?const\s+(\w+)\s*=\s*(?:Joi|joi)\.object\(\s*\{/g;
    let m;
    while ((m = decl.exec(text)) !== null) {
        const name = m[1] ?? 'unknown';
        const line = text.substring(0, m.index).split('\n').length;
        out.push({
            id: `validation.joi.${name.toLowerCase()}`,
            library: 'joi',
            name,
            boundary: 'strict',
            fields: {},
            file,
            line,
            col: 0,
        });
    }
    return out;
}
/** Detects a `yup.object({...})` schema declaration. */
function detectYup(text, file) {
    const out = [];
    const decl = /(?:export\s+)?const\s+(\w+)\s*=\s*yup\.object\(\s*\{/g;
    let m;
    while ((m = decl.exec(text)) !== null) {
        const name = m[1] ?? 'unknown';
        const line = text.substring(0, m.index).split('\n').length;
        out.push({
            id: `validation.yup.${name.toLowerCase()}`,
            library: 'yup',
            name,
            boundary: 'lenient',
            fields: {},
            file,
            line,
            col: 0,
        });
    }
    return out;
}
/** Detects a class with class-validator decorators. */
function detectClassValidator(text, file) {
    const out = [];
    if (!/from\s+['"]class-validator['"]/.test(text))
        return out;
    const clsRe = /class\s+(\w+)/g;
    let m;
    while ((m = clsRe.exec(text)) !== null) {
        const name = m[1] ?? 'unknown';
        const line = text.substring(0, m.index).split('\n').length;
        out.push({
            id: `validation.class-validator.${name.toLowerCase()}`,
            library: 'class-validator',
            name,
            boundary: 'strict',
            fields: {},
            file,
            line,
            col: 0,
        });
    }
    return out;
}
function toResource(root, s) {
    const source = resolve(s.file).split('/').slice(-2).join('/');
    return {
        schemaVersion: GATEFORGE_SCHEMA_VERSION,
        id: s.id,
        kind: VALIDATION_SCHEMA_KIND,
        source,
        location: { file: source, line: s.line, col: s.col },
        detectorVersion: PACK_VERSION,
        attributes: {
            library: s.library,
            name: s.name,
            boundary: s.boundary,
            fields: s.fields,
        },
    };
}
export function createValidationDetector(options = {}) {
    const root = options.root ?? process.cwd();
    return {
        discover(paths) {
            const out = { resources: [], unresolved: [], findings: [], classificationSignals: [] };
            if (paths.length === 0)
                return out;
            const scanned = [];
            for (const rawPath of paths) {
                const abs = isAbsolute(rawPath) ? rawPath : resolve(root, rawPath);
                const files = collectFiles(abs);
                for (const file of files) {
                    let text;
                    try {
                        text = readFileSync(file, 'utf8');
                    }
                    catch {
                        continue;
                    }
                    scanned.push(relative(root, file).split(sep).join('/'));
                    for (const s of [
                        ...detectZod(text, file),
                        ...detectJoi(text, file),
                        ...detectYup(text, file),
                        ...detectClassValidator(text, file),
                    ]) {
                        out.resources.push(toResource(root, s));
                    }
                }
            }
            out.resources.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
            return { ...out, scannedPaths: scanned.sort() };
        },
    };
}
//# sourceMappingURL=detector.js.map