/**
 * Values that end up in a log line come from elsewhere: a lock file, the wire, an environment
 * variable. A line break inside one of them forges an extra line — and these lines are read as
 * evidence by whoever is debugging a machine they cannot log into.
 *
 * `U+0085`, `U+2028` and `U+2029` are not `\r`/`\n` but several viewers treat them as line ends.
 */
export function oneLine(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F\u0085\u2028\u2029]/g, ' ');
}
