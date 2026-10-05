/**
 * Limits and cleaning for text that crosses from one agent to another.
 */

/** The longest message that is passed on. Longer ones are refused, not cut. */
export const MAX_MESSAGE_CHARS = 12_000;

/** An error whose message is written for the agent that called a tool, or for a person at the terminal. */
export class BridgeError extends Error {
  constructor(
    readonly kind:
      | 'invalid_input'
      | 'not_found'
      | 'ambiguous'
      | 'unavailable'
      | 'unsupported'
      | 'refused'
      | 'rate_limited'
      | 'failed',
    message: string,
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}

/**
 * Characters that are removed from a message before it is passed on: control
 * characters other than line break and tab, and the invisible characters that
 * reorder or hide text, which could make a message read differently to a
 * person than to a model.
 */
const HIDDEN = new RegExp(
  // C0 controls except \t and \n, DEL, C1 controls
  '[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f' +
    // zero-width and bidi marks, bidi embeddings and overrides, bidi isolates, BOM
    '\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2069\\ufeff]',
  'g',
);

export function cleanText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[\u2028\u2029]/g, '\n').replace(HIDDEN, '');
}

/** A value for a single line of output: no line breaks, limited length. */
export function oneLine(text: string, max: number): string {
  const flat = cleanText(text).replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
