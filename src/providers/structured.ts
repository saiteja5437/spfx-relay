import { z, type ZodType } from 'zod';

/**
 * Local structured-output validation. Providers may enforce a JSON schema
 * natively, but the pipeline's guarantee comes from HERE: every structured
 * response is JSON-parsed and Zod-validated on our side, uniformly, no matter
 * which provider produced it. Failures carry human-readable issue text that
 * the repair loop feeds back to the model.
 */

export type StructuredParse<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export function parseStructured<T>(rawText: string, schema: ZodType<T>): StructuredParse<T> {
  const jsonText = stripCodeFence(rawText.trim());

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    return { ok: false, error: `Response is not valid JSON: ${(error as Error).message}` };
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { ok: false, error: `Response JSON does not match the required schema — ${issues}` };
  }
  return { ok: true, value: result.data };
}

/** Weaker models wrap JSON in markdown fences despite instructions; tolerate it. */
function stripCodeFence(text: string): string {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
  return fenced?.[1] ?? text;
}

/**
 * Converts a Zod schema to JSON Schema with every object closed
 * (`additionalProperties: false`) — required by Anthropic's structured-output
 * mode and good hygiene everywhere else.
 */
export function closedJsonSchema(schema: ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  closeObjects(json);
  return json;
}

function closeObjects(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) closeObjects(item);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const record = node as Record<string, unknown>;
  if (record['type'] === 'object') {
    record['additionalProperties'] = false;
  }
  for (const value of Object.values(record)) closeObjects(value);
}
