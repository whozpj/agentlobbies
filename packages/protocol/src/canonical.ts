import canonicalize from "canonicalize";

// Drop keys whose value is undefined, at any depth, so an absent optional field and one
// set to undefined sign identically after a JSON round trip (G36).
function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = stripUndefined(v);
    return out;
  }
  return value;
}

/** RFC 8785 canonical JSON. */
export function canonical(value: unknown): string {
  const s = canonicalize(stripUndefined(value));
  if (s === undefined) throw new Error("value cannot be canonicalized");
  return s;
}
