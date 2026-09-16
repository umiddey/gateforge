# @gate-forge/pack-validation

Request-schema validation discovery pack for Gateforge.

## What it detects

| Library         | Detector pattern                          |
|-----------------|-------------------------------------------|
| zod             | `z.object({...})` / `zod.object({...})`   |
| joi             | `Joi.object({...})` / `joi.object({...})`  |
| yup             | `yup.object({...})`                       |
| class-validator | class with decorators from `class-validator` |

Each detected schema becomes one `validation.schema` resource carrying:
- `library` — the validation library used
- `name` — the variable / class name
- `boundary` — `strict` (zod/joi/class-validator) or `lenient` (yup) by default
- `fields` — best-effort field map (zod: type + constraints; others: empty)

## Obligation vocabulary

```
validation:boundary-accepted
validation:boundary-rejected
validation:no-side-effect-on-reject
validation:error-message-explicit
validation:envelope-shape-stable
```

## Limitations

- Field extraction is best-effort: zod schemas get a typed field map; joi / yup / class-validator return `fields: {}` for now. A full schema parser is deferred.
- The detector does not execute user code. Hand-rolled validators without the `validate` / `parse` export convention are NOT recognised.
- Class-validator requires an `import 'class-validator'` line in the same file.
- Schema runtime is intentionally NOT bundled — the example server uses an inline zod-like validator to avoid pulling zod into the test environment.

## Quick start

```ts
import { default as detector } from '@gate-forge/pack-validation';
const outcome = detector.discover(['src/']);
for (const r of outcome.resources) console.log(r.id, r.attributes);
```
