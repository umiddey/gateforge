/**
 * Safe static extraction of adapter field projections. Adapter modules
 * are never executed to answer repository policy questions.
 */
import ts from 'typescript';

/**
 * Removes syntax-only wrappers from a statically inspectable expression.
 *
 * Args:
 *   expression: parsed TypeScript expression.
 *
 * Returns:
 *   ts.Expression: the wrapped expression without parentheses or type syntax.
 */
function unwrapStaticExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * Reads a literal `fields` array from an adapter's default export without
 * evaluating the adapter module.
 *
 * Args:
 *   sourceText: JavaScript or TypeScript module source.
 *
 * Returns:
 *   string[] | null: the declared literal field projection, or null when absent
 *   or when the module uses a dynamic/unrecognized declaration.
 */
export function staticAdapterFieldsFromSource(sourceText: string): string[] | null {
  const source = ts.createSourceFile('adapter.mjs', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const parseDiagnostics =
    (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) return null;
  const exportAssignment = source.statements.find(
    (statement): statement is ts.ExportAssignment => ts.isExportAssignment(statement) && !statement.isExportEquals,
  );
  if (exportAssignment === undefined) return null;
  let exported = unwrapStaticExpression(exportAssignment.expression);
  if (ts.isIdentifier(exported)) {
    const exportName = exported.text;
    const declaration = source.statements
      .filter(ts.isVariableStatement)
      .flatMap((statement) => statement.declarationList.declarations)
      .find((candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === exportName);
    if (declaration?.initializer === undefined) return null;
    exported = unwrapStaticExpression(declaration.initializer);
  }
  if (!ts.isObjectLiteralExpression(exported)) return null;
  const fieldProperties = exported.properties.filter((member) => {
    if (!ts.isPropertyAssignment(member)) return false;
    const name = member.name;
    return (
      (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) &&
      name.text === 'fields'
    );
  });
  if (fieldProperties.length !== 1) return null;
  const property = fieldProperties[0];
  if (property === undefined || !ts.isPropertyAssignment(property)) return null;
  const initializer = unwrapStaticExpression(property.initializer);
  if (!ts.isArrayLiteralExpression(initializer)) return null;
  const fields: string[] = [];
  for (const element of initializer.elements) {
    const value = unwrapStaticExpression(element);
    if (!ts.isStringLiteral(value) && !ts.isNoSubstitutionTemplateLiteral(value)) return null;
    if (value.text.length === 0) return null;
    fields.push(value.text);
  }
  return fields;
}
