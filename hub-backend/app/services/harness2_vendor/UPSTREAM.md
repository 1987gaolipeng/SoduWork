# Embedded Harness² core

Source: [google-research/harness2](https://github.com/google-research/harness2)

Pinned revision: [`1cfe254e8d25b15f37048c3730134686abe60335`](https://github.com/google-research/harness2/tree/1cfe254e8d25b15f37048c3730134686abe60335)

Retrieved: 2026-10-20. Copyright 2026 Google LLC. Apache-2.0; the complete original
license is included in `LICENSE`. This is a SoduWork integration of research
software, not an officially supported Google product.

The package retains the official sequential/parallel Propose–Probe–Compose
algorithm, evidence construction, harness validation, and budget accounting.
It contains no benchmark datasets, third-party benchmark code, or executors.

## Source mapping and modifications

- `__init__.py`, `core/__init__.py`, `core/ledger.py`, and `core/spec.py` retain
  their corresponding upstream source.
- `core/recursion.py` and `core/context.py` retain the upstream algorithm with
  an optional adapter `grader_verdict_markers` setting. The default is the
  original benchmark marker check. SoduWork's adapter explicitly supplies an
  empty tuple because it has no hidden judge or answer-key source; ordinary user
  JSON fields such as `pass_rate` and `passed_count` must remain usable. The
  modification is marked at both checks; other validation remains unchanged.
- `core/tree.py` retains the upstream implementation with two relative paths
  normalized using `Path.as_posix()`. This repairs Windows tree keys and stub
  comparison; the modification is marked in the source.
- `core/prompts_base.py` contains the first portion of upstream `core/prompts.py`;
  `core/prompts.py` contains the remaining functions and imports the first
  portion. Prompt content and function implementations are retained. The split
  keeps each file below SoduWork's 800-line limit.
- `core/proposer.py` retains the upstream result/error contracts and replaces
  the external CLI implementation with a typed callback seam. It cannot launch
  OpenCode, Claude, subprocesses, or model services.
- `config.py` replaces upstream deployment settings with only constants needed
  by the embedded core. It does not read local `.env` files, change process
  environment, discover credentials, or configure Google Cloud.

## SoduWork execution boundary

`../harness2_engine.py` supplies a SoduWork adapter for one sequential recursion
step (`k=1`): four tool-free text planning probes and three model-authored harness
edits. Probe results are real model responses, but they are plans, not completed
business actions. Only four text components can change; scripts, plugins,
subagents, and filesystem paths outside that surface are rejected.

The caller executes the final task once through its existing runtime and
permission mechanism. This differs from the published benchmark setup, whose
probes execute the complete task. Benchmark gains do not establish quality gains
for SoduWork's text planning variant. This integration does not claim the
benchmark launcher, ACP protocol, persistent learning across tasks, or all eight
editable component types are implemented.

The source-only core has no third-party Python dependencies. Official benchmark
requirements (Linux, Python 3.12, Bun, Google Cloud, optional Docker/renderers) do
not apply to this isolated adapter. Windows compatibility is tested through
native Python execution; benchmark launchers and POSIX `fcntl` scheduling code
are intentionally outside the vendored import closure.
