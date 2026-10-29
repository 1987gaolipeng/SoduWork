# SoduWork modification: split upstream module without changing prompt content; see UPSTREAM.md.
# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Every prompt the method sends. Benchmark text arrives as values, never as branches.

The stage prompts are identical across benchmarks; only the `BenchPrompts` slots differ. The
substrate enters exactly once per authoring prompt, as the `# WHAT YOU CAN CHANGE` surface
block selected by the SurfaceSpec's name. No prompt here names a rubric, a score or a judge.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .spec import BenchPrompts
from .tree import SurfaceSpec

from .prompts_base import (
    VERSION,
    _tidy,
    ANSWER_FREE,
    ANSWER_FREE_SELECT,
    EVIDENCE_BOUNDARY,
    POOL_MIXED_SELECT,
    POOL_FINALS_SELECT,
    EVIDENCE_BOUNDARY_SELECT,
    _SURFACE_OPENCODE,
    _SURFACE_CODEX,
    GENERALIZE,
    _KEEP_BASE,
    _work,
    _lens,
    _INV_TEMPLATE,
    _DOM_TEMPLATE,
    _surface_part,
    _TTS_SURFACE_HEAD_OPENCODE,
    _TTS_SURFACE_HEAD_CODEX,
    _TTS_INV,
    _TTS_DOM,
    _TTS_GENERALIZE,
    _TTS_HOW,
)

@dataclass(frozen=True)
class _SurfaceText:
    """The per-substrate prompt fragments, resolved once at module load."""

    surface_md: str
    inv: str
    dom: str
    tts_surface: str


def _build_surface_texts() -> dict[str, _SurfaceText]:
    oc_tts = "\n\n".join(
        [
            _TTS_SURFACE_HEAD_OPENCODE,
            _surface_part(_SURFACE_OPENCODE, "THREE RULES THAT DISCARD", "THE DELIVERABLE'S SHAPE"),
            _surface_part(_SURFACE_OPENCODE, "# HOW TO MAKE A CHANGE"),
        ]
    )
    cx_tts = "\n\n".join(
        [
            _TTS_SURFACE_HEAD_CODEX,
            _surface_part(_SURFACE_CODEX, "A skill only exists", "THE DELIVERABLE'S SHAPE"),
            _surface_part(_SURFACE_CODEX, "# HOW TO MAKE A CHANGE"),
        ]
    )
    return {
        "opencode": _SurfaceText(
            surface_md=_SURFACE_OPENCODE,
            inv=_INV_TEMPLATE.replace(
                "__LOOP_LEVER__",
                "`plugin/<name>.ts` hook -- for example, preventing exit before a "
                "{deliverable} exists",
            ),
            dom=_DOM_TEMPLATE.replace(
                "__TRIGGER_SENTENCE__",
                "A skill exists only once its name appears in the always-on text: write that "
                "trigger line in the same edit.",
            ),
            tts_surface=oc_tts,
        ),
        "codex": _SurfaceText(
            surface_md=_SURFACE_CODEX,
            inv=_INV_TEMPLATE.replace(
                "__LOOP_LEVER__",
                "hook in `.codex/hooks.json` -- for example, blocking a finish before a "
                "{deliverable} exists, with a corrective reason",
            ),
            dom=_DOM_TEMPLATE.replace(
                "__TRIGGER_SENTENCE__",
                "A skill exists only once its name appears in `AGENTS.md` as a trigger: write "
                "that trigger line in the same edit.",
            ),
            tts_surface=cx_tts,
        ),
    }


_SURFACE_TEXTS = _build_surface_texts()


def _st(surface: SurfaceSpec | str) -> _SurfaceText:
    name = surface if isinstance(surface, str) else surface.name
    got = _SURFACE_TEXTS.get(name)
    if got is None:
        raise ValueError(f"no prompt surface for {name!r}; known: {sorted(_SURFACE_TEXTS)}")
    return got


def _tts_propose(bp: BenchPrompts, dim: str, st: _SurfaceText, *, k: int, index: int) -> str:
    """propose(), in the tts pack's words."""
    block = (_TTS_INV if dim == "INV" else _TTS_DOM).format(
        deliverable=bp.deliverable_word,
        domain=bp.domain_word,
        levers=(bp.inv_levers if dim == "INV" else bp.dom_levers).strip(),
    )
    where = (
        "Do not hedge toward an average or try to cover every base -- commit to the single "
        "most defensible version of your dimension. A later stage compares and merges."
    )
    if k > 1:
        where = (
            f"You are candidate {index} of {k} on this dimension, drawn independently from "
            f"the same evidence and never shown the others. "
        ) + where
    parts = [
        f"You are the {'INVARIANT' if dim == 'INV' else 'DOMAIN'} harness editor for one "
        f"task in this {bp.domain_word}. You have the CURRENT real task, FULL rollouts of "
        f"it under the current (base) harness, the current harness files, and this area's "
        f"library of what was adopted for earlier tasks.",
        _work(bp),
        _lens(bp),
        block,
        _TTS_GENERALIZE.format(
            domain_word=bp.domain_word, DOMAIN_WORD_UPPER=bp.domain_word.upper()
        ),
        _TTS_HOW,
        where,
    ]
    if bp.yardstick.strip():
        parts.append(f"# WHAT GOOD PROCESS LOOKS LIKE HERE\n\n{bp.yardstick.strip()}")
    parts += [ANSWER_FREE, EVIDENCE_BOUNDARY, st.tts_surface]
    return _tidy("\n\n".join(parts))


def _tts_aggregate(bp: BenchPrompts, st: _SurfaceText, *, k: int, index: int) -> str:
    """aggregate(), in the tts pack's words."""
    n = 2 * k
    parts = [
        "You are the integration judge and synthesizer. What you emit is what gets ADOPTED: it "
        "runs on this task, and if selected it enters this area's library where later tasks read "
        "it. Every rule that bound the candidate proposers binds you -- merging an edit does not "
        "launder it.",
        _work(bp),
        _lens(bp),
        f"# WHAT YOU HAVE\n\n"
        f"{k} rollout{'s' if k > 1 else ''} of this task under the unmodified (base) harness, "
        f"and {n} dimension-scoped candidate harnesses built on that same base -- {k} on the "
        f"INVARIANT dimension (tool and procedure machinery) and {k} on the DOMAIN dimension "
        f"(what a professional in this field knows). Each candidate was rolled out ONCE and you "
        f"have that rollout. All of it is in your workspace:\n\n"
        f"    context/task.md               the real task\n"
        f"    context/harness/              the base harness files, and the tree you edit\n"
        f"    context/rollouts/<label>.md   FULL trajectories, untruncated\n"
        f"    context/deliverables/         what each base rollout actually PRODUCED, one "
        f"entry per rollout\n"
        f"    context/pool/<label>/         one per candidate: `harness/` (its files), "
        f"`rollout.md`\n"
        f"                                  and `produced.md` (what its rollout delivered)\n"
        f"    context/library/              earlier tasks' adopted harnesses (browse INDEX.md)\n\n"
        f"Open what each side PRODUCED, not only its trajectory: judging an edit without reading "
        f"its product is guessing.",
        "# YOUR JOB\n\n"
        "1. Judge each candidate edit from the evidence: did its rollout show it helped, hurt, "
        "or did nothing versus the base rollouts? The task's user request is the yardstick -- "
        "completeness against what was asked counts as much as correctness of what was "
        "produced. An edit whose skill was never loaded or whose rule was ignored changed "
        "nothing, whatever it says on paper.\n"
        "2. Synthesize ONE final harness containing only what the evidence supports: merge the "
        "good parts of both dimensions, resolve overlaps rather than concatenating, keep "
        "always-on text tiny, and keep every retained skill's trigger line narrow. Adopting a "
        "single candidate wholesale is valid when it is simply the best state.\n\n"
        "KEEPING THE BASE UNCHANGED IS A VALID OUTCOME -- if no candidate demonstrably improved "
        "on base, leave the tree as it is and say KEEP_BASE in your notes. " + _KEEP_BASE,
        (
            f"You are one of {k} synthesizers composing a final from this same evidence in "
            f"parallel, and you will not see the others. Do not aim for the consensus answer -- "
            f"commit to the harness you can defend."
            if k > 1
            else ""
        ),
        *(
            [f"# WHAT GOOD PROCESS LOOKS LIKE HERE\n\n{bp.yardstick.strip()}"]
            if bp.yardstick.strip()
            else []
        ),
        ANSWER_FREE,
        EVIDENCE_BOUNDARY,
        st.tts_surface,
        "# NOTES FORMAT\n\n"
        "In your single `<notes>` block, one line per decision:\n\n"
        "    kept|revised|dropped -> <which edit> -> <the evidence: what the trajectories "
        "showed, with counts where sets are involved>\n\n"
        "A decision without evidence attached is a decision the next reader cannot audit.",
    ]
    return _tidy("\n\n".join(parts))


def _tts_select(bp: BenchPrompts, n: int, pool_kind: str, assets_note: str) -> str:
    """select(), in the tts pack's words: its own three criteria supersede `selection_lead`,
    `selection_conformance` and `selection_checks` rather than layering on them.
    """
    return _tidy(
        "\n\n".join(
            [
                f"You are choosing which of {n} candidate ANSWERS to a workplace task should be "
                f"delivered to the person who asked for this work.",
                _work(bp),
                POOL_MIXED_SELECT if pool_kind == "mixed" else POOL_FINALS_SELECT,
                "# WHAT YOU ARE LOOKING AT\n\n"
                "Each candidate is what one agent run produced for the SAME task, in full.\n\n"
                "    context/task.md              the request, verbatim\n"
                "    context/source/             the material the work was done from\n"
                f"    context/candidates/<id>.md  what that run PRODUCED -- the "
                f"{bp.deliverable_word}, rendered\n" + (assets_note or "") + "\n"
                "You are choosing between ARTIFACTS. You are not told how any of them was produced and "
                "you cannot see the runs that made them, so judge each one on what it is, against the "
                "request and the source -- never on how impressive or thorough it sounds.",
                "# HOW TO DECIDE, IN THIS ORDER\n\n"
                f"1. COVERAGE. Is every {bp.deliverable_word} the instructions name present, and does "
                f"each contain every section, field, value or analysis they ask for? Count what the "
                f"request explicitly asks to be produced, computed, stated or explained, and prefer the "
                f"candidate that answers the most of those points.\n\n"
                "2. CORRECTNESS. Are the values internally consistent -- totals matching their "
                "components, figures agreeing between files, counts matching what the source actually "
                "contains? Where candidates disagree on a number, check `context/source/` and prefer "
                "the one whose derivation the material supports. Reject invented specifics; where the "
                "source is silent, a candidate that says so is safer than one that fills the gap "
                "confidently.\n\n"
                "3. FIDELITY. Required formats, file names and structure, and no placeholder, TODO, "
                "unresolved note, broken reference or empty required field. A renderer-truncation "
                "marker inserted for this comparison is not a defect in the original artifact; judge "
                "only what is actually visible.\n\n"
                "Length and polish are not merits in themselves. The candidates are independent "
                "attempts of differing quality, better than each other in different respects, and it is "
                "entirely possible that the plainest one is the best answer. Pick the best available "
                "answer, not the most elaborate one.",
                ANSWER_FREE_SELECT,
                EVIDENCE_BOUNDARY_SELECT,
                "# OUTPUT FORMAT\n\nFirst the reasoning, then the choice as the very last thing:\n\n"
                "<why>\nAt most 5 lines. Name the criterion that decided it, and the closest runner-up "
                "with the specific thing that cost it the pick.\n</why>\n\n"
                "```choice\n<the id of the single candidate to submit>\n```",
            ]
        )
    )


def propose(
    bp: BenchPrompts,
    dim: str,
    surface: SurfaceSpec | str,
    *,
    k: int = 1,
    index: int = 1,
    round_t: int | None = None,
) -> str:
    """The job for one INV or DOM candidate. `round_t` set => sequential mode, pass t."""
    if dim not in ("INV", "DOM"):
        raise ValueError(f"unknown proposal dimension {dim!r}; expected 'INV' or 'DOM'")
    st = _st(surface)

    if bp.prompt_pack == "tts" and round_t is None:
        return _tts_propose(bp, dim, st, k=k, index=index)
    block = (st.inv if dim == "INV" else st.dom).format(
        deliverable=bp.deliverable_word,
        domain=bp.domain_word,
        levers=(bp.inv_levers if dim == "INV" else bp.dom_levers).strip(),
    )
    where = (
        f"You are candidate {index} of {k} on this dimension, drawn independently from the "
        f"same evidence."
        if k > 1
        else ""
    )
    if round_t:
        where += (
            f"\n\nThis is round {round_t}. You are editing the checkpoint the previous "
            f"round produced, not the original harness, and the evidence includes every "
            f"earlier round. In this stage `KEEP_BASE` means leave that CURRENT checkpoint "
            f"unchanged; it never resets to the original harness."
        )
    how = [
        "# HOW TO DECIDE WHAT TO CHANGE\n",
        "Every edit must trace to a moment in a trajectory. For each one ask: which run did "
        "what, and would this text have changed it? If you cannot name the moment, the edit "
        "is speculation and costs context for nothing. Prefer, in order:",
        "  1. a DIVERGENCE -- the runs disagreed, so the agent can already do it and just "
        "needs telling. This is the cheapest win.",
        "  2. a repeated concrete failure -- the same error or omission in every run.",
        "  3. a risk visible in a trajectory but not yet realised.",
        "Do not fix what the runs already got right, and do not restate what the harness "
        "already says clearly; duplicated instruction dilutes the rest.",
    ]
    if where.strip():
        how += ["", where.strip()]
    how += [
        "",
        "Do not hedge toward an average or try to cover every base -- commit to the "
        "single most defensible version of your dimension. A later stage compares and "
        "merges.",
    ]

    parts = [
        "You are adapting an autonomous agent's harness.",
        _work(bp),
        _lens(bp),
        block,
        GENERALIZE.format(domain_word=bp.domain_word, DOMAIN_WORD_UPPER=bp.domain_word.upper()),
        "\n".join(how),
    ]
    if bp.yardstick.strip():
        parts.append(f"# WHAT GOOD PROCESS LOOKS LIKE HERE\n\n{bp.yardstick.strip()}")
    parts += [ANSWER_FREE, EVIDENCE_BOUNDARY, st.surface_md]
    return _tidy("\n\n".join(parts))


def aggregate(bp: BenchPrompts, surface: SurfaceSpec | str, *, k: int = 1, index: int = 1) -> str:
    """agg-k: compose ONE final from all base evidence and all 2k candidates."""
    st = _st(surface)
    if bp.prompt_pack == "tts":
        return _tts_aggregate(bp, st, k=k, index=index)
    n = 2 * k
    return _tidy(
        "\n\n".join(
            [
                "You are composing THE final harness for one piece of work. What you emit is what gets "
                "ADOPTED: it runs on this task, and if selected it enters this area's library where "
                "later tasks read it. Every rule that bound the candidate proposers binds you -- you "
                "are the last gate, and merging an edit launders it.",
                _work(bp),
                _lens(bp),
                f"# WHAT YOU HAVE\n\n"
                f"{k} rollout{'s' if k > 1 else ''} under the unmodified harness, and {n} candidate "
                f"harnesses -- {k} on the INV dimension (how the agent works) and {k} on the DOM "
                f"dimension (what a practitioner knows). Each candidate was rolled out ONCE and you "
                f"have that rollout.\n\n"
                f"The candidates were sampled separately but share the same task, evidence and likely "
                f"model biases. Agreement is support, not independent proof; contradiction is a reason "
                f"to inspect the trajectories, not to vote.",
                f"# HOW TO WEIGH THE EVIDENCE\n\n"
                f"The {k} base rollout{'s are' if k > 1 else ' is'} draws from ONE distribution -- "
                f"read them as a set, not as {k} separate stories.\n\n"
                f"- A failure that repeats across the base set is a real property of the base harness "
                f"and the strongest thing you can act on. A defect in 1/{k} is noise, and an edit "
                f"aimed at it is overfitting to one sample.\n"
                f"- Each candidate has ONE rollout, so a single good or bad outcome is weak evidence "
                f"either way. An edit earns its place when a SPECIFIC MOMENT in a trajectory shows "
                f"the mechanism -- 'this looks like good practice' is not evidence; name the moment.\n"
                f"- Judge the downside as heavily as the upside. The costliest failure on this work "
                f"is a run that produces nothing; an edit that helps one rollout and risks emptiness "
                f"elsewhere is a bad edit.\n"
                f"- IF ANY ROLLOUT ASSOCIATED WITH AN EDIT PRODUCED NOTHING, say so explicitly in "
                f"your notes and treat that edit as UNSAFE unless the rest of the evidence is "
                f"overwhelming. Never merge an edit from a non-delivering rollout without stating "
                f"why.",
                "# YOUR JOB\n\nCompose ONE harness. All of these are valid, judged only on what the "
                "rollouts support:\n"
                "- MERGE across candidates -- the expected outcome when an INV edit and a DOM edit each "
                "earn their place. Resolve the overlaps rather than concatenating.\n"
                "- ADOPT ONE WHOLESALE if a single candidate is simply the best state.\n"
                "- KEEP_BASE.\n\n" + _KEEP_BASE,
                (
                    f"You are one of {k} aggregators composing a final from this same evidence in "
                    f"parallel, and you will not see the others. Do not aim for the consensus answer -- "
                    f"commit to the harness you can defend."
                    if k > 1
                    else ""
                ),
                *(
                    [f"# WHAT GOOD PROCESS LOOKS LIKE HERE\n\n{bp.yardstick.strip()}"]
                    if bp.yardstick.strip()
                    else []
                ),
                ANSWER_FREE,
                EVIDENCE_BOUNDARY,
                st.surface_md,
                "# NOTES FORMAT\n\n"
                "In your single `<notes>` block, one line per decision, in this exact shape:\n\n"
                "    kept|revised|dropped -> <which edit> -> <the trajectory moment or base-set "
                "pattern that decided it, with counts where sets are involved, e.g. 'failed in "
                f"{max(k - 1, 2)}/{k} base rollouts'>\n\n"
                "A decision without evidence attached is a decision the next reader cannot audit.",
            ]
        )
    )


def compose_round(bp: BenchPrompts, surface: SurfaceSpec | str, *, t: int, k: int) -> str:
    """seq-k: compose checkpoint C_t from this round's candidates and every earlier round."""
    st = _st(surface)
    final = t >= k
    return _tidy(
        "\n\n".join(
            [
                f"You are composing checkpoint {t} of {k} in a sequential adaptation loop.",
                _work(bp),
                _lens(bp),
                "# WHAT YOU HAVE\n\n"
                "The rollouts under the unmodified harness (the shared evidence, which does not change "
                "between rounds), this round's INV and DOM candidates with their rollouts, and every "
                "earlier round's candidates, checkpoints and trajectories. The previous checkpoint's "
                "own rollout is this round's on-policy evidence: it shows what the harness you are "
                "editing actually does."
                + (
                    "\n\nThis is the FIRST round, so the only evidence is the base rollouts and this "
                    "round's two candidates."
                    if t == 1
                    else ""
                ),
                "# YOUR JOB\n\n"
                + (
                    "Compose THE FINAL harness, from the WHOLE history rather than just this round.\n"
                    if final
                    else f"Compose checkpoint {t}, which the next round will build on.\n"
                )
                + "All of these are valid:\n"
                "- MERGE across rounds -- including a candidate REJECTED earlier, if a later rollout "
                "now argues for it.\n"
                "- REPRODUCE an earlier checkpoint verbatim, if that state was simply the best one "
                "and later rounds drifted away from it.\n"
                "- ADOPT this round's best candidate.\n"
                "- KEEP_BASE.\n\n"
                + _KEEP_BASE
                + "\n\nHere `KEEP_BASE` means keep the CURRENT checkpoint in `context/harness/` "
                "unchanged; it does not restore the original harness. In `<notes>`, identify which "
                "rounds' edits survive and which were dropped or restored.",
                ANSWER_FREE,
                EVIDENCE_BOUNDARY,
                st.surface_md,
            ]
        )
    )


def _checks(bp: BenchPrompts) -> str:
    """What correctness means for THIS artifact family. Empty when the adapter says nothing."""
    body = bp.selection_checks.strip()
    return f"# WHAT CORRECTNESS MEANS FOR THIS WORK\n\n{body}" if body else ""


CONFORMANCE_BLOCK = (
    "2. CONFORMANCE. Is it ONLY what was asked for? Where the instructions name fields, "
    "columns, sheets, sections or an order, those define the artifact's SHAPE, and the shape "
    "is part of the request. Extra columns, extra sheets, added commentary rows, renamed or "
    "re-worded headers, merged title rows, and reordered fields are DEVIATIONS, not "
    "improvements -- however helpful they look. A downstream reader or importer may key on "
    "exact names and positions, and cannot ask you what you meant. Where the instruction is "
    "explicit, match it exactly; where it is silent, prefer the plainest form that satisfies "
    "it.\n"
    "   A value the request asks for must be PRESENT AS A VALUE. An artifact that leaves the "
    "reader to recompute it -- a spreadsheet formula in place of the number, a placeholder "
    "to be filled, a described-but-not-performed calculation -- has not delivered that "
    "value.\n\n"
)

VALUE_TAIL = (
    "7. VALUES ARE VALUES. A value the request asks for must be PRESENT AS A VALUE. An "
    "artifact that leaves the reader to recompute it -- a spreadsheet formula in place of "
    "the number, a placeholder to be filled, a described-but-not-performed calculation -- "
    "has not delivered that value.\n\n"
)


def select(bp: BenchPrompts, n: int, pool_kind: str = "mixed", assets_note: str = "") -> str:
    """Blind selection over candidate outputs, substrate-free; `pool_kind` picks the anonymity
    block, `assets_note` names any per-candidate rendered evidence selection copied.
    """
    if pool_kind not in ("mixed", "finals"):
        raise ValueError(f"unknown pool_kind {pool_kind!r}; expected 'mixed' or 'finals'")
    if bp.prompt_pack == "tts":
        return _tts_select(bp, n, pool_kind, assets_note)
    return _tidy(
        "\n\n".join(
            [
                f"You are choosing which of {n} candidate answers should be delivered to the person "
                f"who asked for this work.",
                _work(bp),
                _lens(bp),
                POOL_MIXED_SELECT if pool_kind == "mixed" else POOL_FINALS_SELECT,
                "# WHAT YOU ARE LOOKING AT\n\n"
                "    context/task.md              the request, verbatim\n"
                "    context/source/             the material the work was done from\n"
                f"    context/candidates/<id>.md  what that run PRODUCED -- the "
                f"{bp.deliverable_word}, rendered\n" + (assets_note or "") + "\n"
                "You are choosing between ARTIFACTS. You are not told how any of them was produced and "
                "you cannot see the runs that made them, so judge each one on what it is, against the "
                "request and the source -- never on how impressive or thorough it sounds.",
                "# HOW TO DECIDE, IN THIS ORDER\n\n"
                + (f"0. {bp.selection_lead.strip()}\n\n" if bp.selection_lead.strip() else "")
                + f"1. DELIVERY. Is every {bp.deliverable_word} named by the instructions present, at the "
                f"requested path, in the requested form, with every named part?\n\n"
                + ("" if bp.selection_conformance == "value_only" else CONFORMANCE_BLOCK)
                + "3. FIDELITY. CHECK THE CLAIMS AGAINST `context/source/`, which holds the material the "
                "work was done from. Open it and verify the facts, data, names, figures and constraints "
                "a candidate asserts -- do not take its word for them, and do not settle for whether it "
                "sounds authoritative. Reject invented specifics. Where candidates disagree, the source "
                "decides it; where the source is silent, prefer the candidate that says so over the one "
                "that fills the gap confidently.\n\n"
                "4. INTERNAL CONSISTENCY. Does the artifact agree with itself? Totals that match their "
                "rows, figures that agree between a summary and the table it summarises, "
                "cross-references that resolve, counts that match the number of items actually present. "
                "A number that contradicts another number in the same artifact is a defect even when you "
                "cannot tell which one is wrong.\n\n"
                "5. OPERATIONAL FITNESS. Is this the right kind of artifact, and can the intended person "
                "or system actually use, run, open, import or act on it without reconstructing missing "
                "work? Judge this as the requester's downstream consumer, not as a reviewer wanting to "
                "be convinced -- an addition that helps a human read the file but breaks an importer is "
                "a cost, not a benefit.\n\n"
                "6. FINISH. No placeholders, TODOs, unresolved notes, broken references, empty required "
                "fields, visibly incomplete sections, or content that does not match its declared format. "
                "A renderer-truncation marker inserted for this comparison is not a defect in the original "
                "artifact; judge only what is actually visible.\n\n"
                + ("" if bp.selection_conformance == "full" else VALUE_TAIL)
                + "Length and polish are not merits in themselves. A shorter, correct, complete, "
                "exactly-shaped answer beats a longer one with a gap or an embellishment.",
                _checks(bp),
                ANSWER_FREE_SELECT,
                EVIDENCE_BOUNDARY_SELECT,
                "# OUTPUT FORMAT\n\nFirst the reasoning, then the choice as the very last thing:\n\n"
                "<why>\nAt most 6 lines. Name the criterion that decided it, and the closest runner-up "
                "with the specific thing that cost it the pick. If you rejected a candidate on "
                "CONFORMANCE, say which field, column or section.\n</why>\n\n"
                "```choice\n<the id of the single candidate to submit>\n```",
            ]
        )
    )


def experience(bp: BenchPrompts) -> str:
    """Two records: what each harness edit did, then the one lesson that transfers."""
    return _tidy(
        "\n\n".join(
            [
                "You are reading the complete record of one improvement round: a base harness, the "
                "edits proposed against it, the executions those edited harnesses produced, and which "
                "output was finally submitted. Write two things for a library that future work in this "
                "area reads before it makes its own edits.",
                _work(bp),
                _lens(bp),
                "# THE ADOPTED CANDIDATE IS NOT THE ONLY EVIDENCE\n\n"
                "Selection compared DELIVERABLES with the harnesses hidden, so the choice says which "
                "output read best -- not which edit worked. Treat every candidate as evidence. An edit "
                "that appeared only in a rejected candidate may still be the one that changed behavior "
                "for the better, and an edit inside the adopted candidate may have contributed nothing "
                "to why it was adopted. Read the trajectories, not the verdict.",
                "# WHAT EACH EDIT DID\n\n"
                "Diff every candidate harness against `context/base_harness/`. For each component any "
                "candidate changed, write one row: the component, what the edit actually changed, the "
                "observed difference in execution it produced, and a verdict.\n\n"
                "Verdicts are `helped`, `hurt`, `no observed effect` and `confounded`. Use "
                "`confounded` -- and prefer it -- whenever a candidate changed several components at "
                "once and no execution isolates one of them, or when a single rollout is all that "
                "stands behind the difference. A confounded row is a useful record; an invented "
                "attribution poisons the library for every later task. Cite the run and the point in "
                "the trajectory where behavior diverges. If two candidates changed the same component "
                "in different ways, say which forms were tried and what each produced.",
                "# THE ONE LESSON THAT TRANSFERS\n\n"
                "Now write at most one durable entry, and only if the edit rows support it.\n\n"
                "The `cue` describes the SHAPE OF SITUATION the lesson applies to, so it can fire on a "
                "different matter. Not this task's facts -- the pattern. The `lesson` is the operation "
                "to perform on a harness, stated so it can be applied and checked, and it must name "
                "the component it concerns.\n\n"
                "Too generic is useless ('be thorough'); too specific never fires again ('the fee rose "
                "to 250 on Jan 1'). Aim between: 'when an instrument performs several sequential acts "
                "and one of them terminates the actor's own authority, order them so the terminating "
                "act comes last'.\n\n"
                "The `evidence` field cites the edit rows the lesson rests on. A lesson resting only "
                "on `confounded` rows is a guess: narrow it to what the record does show, or decline. "
                "Adoption alone never establishes that an edit helped or will transfer. If the record "
                "shows no concrete, reusable execution contrast, write the single line NO_ENTRY in "
                "place of the <experience> block -- the edit rows are still worth writing.",
                ANSWER_FREE,
                EVIDENCE_BOUNDARY,
                "# OUTPUT FORMAT\n\n"
                "<edits>\ncomponent: <name as it appears in the harness tree>\n"
                "candidates: <the labels that carried this edit>\n"
                "change: <what the edit did>\n"
                "observed: <the execution difference, and where you saw it>\n"
                "verdict: <helped|hurt|no observed effect|confounded>\n"
                "(repeat these five lines for each changed component)\n</edits>\n\n"
                "<experience>\ncue: <the shape of situation this applies to>\n"
                "lesson: <the transferable operation, naming the component>\n"
                "evidence: <the edit rows this rests on, and the execution contrast>\n"
                "confidence: <high|medium|low, and why>\n</experience>",
            ]
        )
    )
