/**
 * The secret-shape guard for everything Gateforge prints about a test it
 * did not itself write.
 *
 * The progress stream and the failing-test artifact carry the test TITLE
 * (declared code, committed) and the runner's own error MESSAGE (runtime
 * data). The title is safe by review; the message is not — a failing
 * assertion routinely quotes the response body, the request payload, or
 * the env value the suite was handed, and those ARE the secrets a CI log
 * must never receive.
 *
 * The guard is deliberately a MATCH, never a rewrite: a value that looks
 * like a secret is REPLACED by a fixed marker, never trimmed, masked, or
 * partially quoted (a prefix of a secret is still a secret). The caller
 * decides what to print in its place; this module only answers "could
 * this be a credential?".
 *
 * Every pattern here is a SHAPE, never a value: the module never embeds
 * a real credential, and no test may print one either (build a planted
 * value at runtime from fragments instead).
 */

/**
 * Credential SHAPES, checked case-sensitively unless noted. Each is a
 * structural signature a test title or an error message either has or
 * does not — none of them can match ordinary prose.
 */
const SECRET_SHAPES: readonly RegExp[] = [
  // A JSON Web Token: three base64url segments, the first a JOSE header.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/,
  // A bearer credential in a header dump.
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  // A provider key prefix (sk-, rk-, pk-, ghp_, gho_, xoxb-, api-…)
  // followed by a long opaque body.
  /\b(?:sk|rk|pk|api|ghp|gho|ghu|ghs|xox[baprs])[-_][A-Za-z0-9_-]{16,}/i,
  // An AWS access key id.
  /\bAKIA[0-9A-Z]{16}\b/,
  // A PEM private key block.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // A credential-shaped assignment in a quoted payload or a config dump:
  // `password: "…"`, `api_key=…`, `token => …`.
  /\b(?:token|secret|password|passwd|api[-_]?key|access[-_]?key|authorization|cookie)\b\s*[=:=>]{1,2}\s*["']?[A-Za-z0-9+/_-]{20,}/i,
  // A GitHub fine-grained personal access token.
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  // A long (40+) hex blob on its own: a session id, a hash, or a key.
  /\b[0-9a-fA-F]{40,}\b/,
];

/**
 * Whether a string carries the shape of a credential.
 *
 * The answer is all the caller needs: a matching string is REPLACED
 * wholesale, never filtered, so a near miss can never leak a fragment.
 *
 * Args:
 *   text: the candidate string (a test title, an error message, a
 *     request or response fragment).
 *
 * Returns:
 *   boolean: true when the text matches any credential shape.
 */
export function looksLikeSecret(text: string): boolean {
  return SECRET_SHAPES.some((shape) => shape.test(text));
}
