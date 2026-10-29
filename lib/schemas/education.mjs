// lib/schemas/education.mjs — the model boundary for education extraction.
//
// A BAD FIELD COSTS ITS FIELD, NOT THE RECORD. One out-of-range value must not throw away a whole model
// response. `coerceEducation` drops what it cannot read and
// reports the count, so loss shows up in the run output instead of hiding in a pass rate.
import { z } from "zod";

const YEAR = z.number().int().min(1940).max(2035).nullable().catch(null).default(null);

export const EducationEntry = z.object({
  institution: z.string().min(2).max(200),
  degree: z.string().max(200).nullable().catch(null).default(null),
  grad_year: YEAR,
});

export const Education = z.object({
  institution: z.string().max(200).nullable().default(null),
  degree: z.string().max(200).nullable().default(null),
  grad_year: YEAR,
  all: z.array(EducationEntry).max(12).default([]),
});

const clean = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
const capped = (v, n) => { const c = clean(v); return c && c.length <= n ? c : null; };

/** Salvage one response. Returns { ok, data, droppedEntries }. Nothing is truncated to fit. */
export function coerceEducation(raw) {
  if (!raw || typeof raw !== "object") return { ok: false, data: null, droppedEntries: 0 };
  const inAll = Array.isArray(raw.all) ? raw.all : [];
  const all = [];
  for (const e of inAll.slice(0, 12)) {
    const p = EducationEntry.safeParse({
      institution: clean(e?.institution), degree: capped(e?.degree, 200),
      grad_year: Number.isFinite(e?.grad_year) ? e.grad_year : null,
    });
    if (p.success) all.push(p.data);
  }
  const p = Education.safeParse({
    institution: capped(raw.institution, 200), degree: capped(raw.degree, 200),
    grad_year: Number.isFinite(raw.grad_year) ? raw.grad_year : null, all,
  });
  return { ok: p.success, data: p.success ? p.data : null, droppedEntries: inAll.length - all.length };
}
