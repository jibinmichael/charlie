# evals/ — the grounding regression gate

This suite lets prompts change without raising the hallucination rate. Grounding is checked on every
send at run time; this suite makes a prompt or rubric edit that would weaken it fail before it reaches
a real inbox.

## Two layers

The semantic grounded/ungrounded judgment is a live API call (`grounding-verify.mjs`
`verifyGrounding`). CI runs with no API key, so the gate is split:

| Layer | Runs | Catches |
|---|---|---|
| **Deterministic** (`*.test.mjs`) | `npm test` → CI, no API | enforcement weakening, rubric-clause deletion, shape drift, dashed voice |
| **Live** (`live.mjs`) | `node --env-file=.env.local evals/live.mjs`, opt-in, needs `ANTHROPIC_API_KEY` (skips without it) | the auditor missing an invented claim / over-flagging a grounded one |

- `grounding.test.mjs` — feeds labelled composed emails + the violations a correct auditor returns to
  `citeOrDrop`; proves every flagged claim is dropped and no grounded claim is touched.
- `rubric-lint.test.mjs` — asserts `dossier.md` / `composer.md` / the auditor prompt keep their
  grounding-craft clauses (closed-world, say-less-not-invent, never-invent, never-upgrade).
- `voice.test.mjs` — no em/en dash; the person's name verbatim where present.
- `schema.test.mjs` — dossier fixtures satisfy the `Dossier` Zod schema (shape can't drift).
- `salary-boundary.test.mjs` — the interrogation prompt keeps its clause that pay negotiation is out
  of scope, and the offer-stage email does not reopen it.
- `interrogate/interrogate.test.mjs` — conversation-tier claims trace back to the source (see below).

Opt-in live checks (need `ANTHROPIC_API_KEY`, send nothing, write nothing):

- `live.mjs` — the grounding auditor against the corpus.
- `interrogate-live.mjs` — tries to make the interrogation prompt ask a pay-negotiation question.
- `vv/adversarial-live.mjs` — the voice-verification writer and judge against `vv/adversarial/cases.json`
  (also needs `VOICE_WRITER_MODEL` and `VOICE_JUDGE_MODEL`). `vv/test-plan.json`, `vv/personas/` and
  `vv/evidence/` are fixtures shared with the `voice/` tests.

`lib/load.mjs` loads the corpus deterministically.

## Run

```
npm run test:evals                                        # the deterministic gate (also part of `npm test`)
node --env-file=.env.local evals/live.mjs                # the live judge test; run before merging a generation-prompt change
node evals/interrogate-live.mjs                           # live red-team of the interrogation prompt
node --env-file=.env.local evals/vv/adversarial-live.mjs  # live voice writer and judge cases
```

## Add a fixture

Drop a JSON file in `corpus/<surface>/` (`composer`, `dossier`, or `interrogate`):

```json
{
  "surface": "composer",
  "label": "clean | adversarial",
  "source": "the resume/dossier the artifact was written from",
  "artifact": { "fields": { "...": "..." }, "cov": { "...": "..." } },
  "violations": [{ "claim": "<exact ungrounded span>", "issue": "why" }],
  "expectAllFitDropped": false
}
```

- **clean** → `violations: []`; the suite proves nothing is dropped.
- **adversarial** → plant one invented employer/title/metric/upgrade in `artifact`, and list the exact
  span(s) a correct auditor returns in `violations`; the suite proves the enforcer drops each and none
  survive. Keep every specimen synthetic: never put a real person's resume or email here.
- `dossier` fixtures use the dossier JSON as `artifact`; add `expectName` to assert the name is verbatim.
- `interrogate` fixtures are a different shape: `{ source, dossier: {proof_points:[...]}, expectGrounded }`.
  `interrogate/interrogate.test.mjs` runs `writebackIsGrounded(dossier, source)` and asserts every
  conversation-tier claim traces to the source (clean → grounded, adversarial → a planted invented metric
  is flagged). The prompt's grounding clauses are locked by `rubric-lint.test.mjs`; a live judge on the
  generated questions rides `evals/live.mjs`.
