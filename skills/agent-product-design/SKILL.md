---
name: agent-product-design
description: Design enterprise agent products and interactive prototypes that make goals, plans, tool use, evidence, permissions, human gates, recovery, and final delivery understandable and controllable. Use when turning a requirement into an AI assistant, autonomous agent, human-AI workflow, agent workspace, or clickable agent-product prototype.
---

# Agent Product Design

Design the work system, not a chatbot shell. Make the user understand what the agent is doing, why it is allowed to do it, what evidence proves completion, and where a human remains in control.

## Deliverables

Produce these artifacts:

1. requirements.md — users, jobs, scope, scenarios, information architecture, exceptional states, and testable acceptance criteria.
2. agent-design.md — the agent contract, autonomy, tools, memory, gates, evidence, recovery, and evaluation.
3. prototype.html — a self-contained clickable prototype that demonstrates the core work loop.
4. A review conclusion that maps every acceptance criterion to visible evidence.

Do not substitute a feature list, dashboard, static landing page, or chat mockup for an agent product.

## Work from outcome to interaction

### 1. Define the work

State:

- Who requests the work and who receives the result.
- The business outcome, not merely the requested screen.
- Inputs, attachments, systems, constraints, and sensitive data.
- The completion standard and evidence a reviewer can inspect.
- What remains outside the first deliverable.

If the input is incomplete, choose the smallest reversible assumption and record it. Do not invent integrations, credentials, data, or production capability.

### 2. Define the agent contract

For each agent role, specify:

- Mission and boundaries.
- Inputs and normalized working context.
- Plan and progress representation.
- Allowed tools, data sources, Skills, and MCP connections.
- Permission mode: read-only, confirm before change, or pre-authorized action.
- Memory scope and retention.
- Human gates and escalation conditions.
- Evidence captured for each consequential action.
- Retry, resume, cancellation, and rollback behavior.
- Final deliverable and quality evaluation.

Prefer MCP or APIs, then browser automation, then computer control. Never imply a tool exists when it is not configured.

### 3. Design the visible work loop

Use one coherent lifecycle:

1. Understand the request.
2. Form or update a plan.
3. Execute visible steps.
4. Ask for permission only at real gates.
5. Verify against completion criteria.
6. Deliver results and evidence.
7. Capture feedback for future improvement.

The primary surface is the current task or conversation. Keep secondary details progressive:

- Show short narrative updates at meaningful stage changes.
- Collapse commands, reads, writes, and browser actions into compact activity rows.
- Let users inspect details without flooding the main conversation.
- Keep the active plan and current step visible.
- Present files as direct links and runnable web results in a preview surface.
- Separate evidence from marketing claims.

### 4. Prototype real states

The prototype must include deterministic local interactions for at least:

- A normal end-to-end completion.
- Missing information or a permission gate.
- Tool or validation failure followed by retry or human takeover.

Also cover loading, empty, paused, cancelled, and completed states where relevant. A button must change meaningful state; decorative controls do not count as interaction.

For a self-contained HTML prototype, simulate the agent locally with an explicit state machine. Label external integrations as prototype simulations. Do not call remote models, CDNs, or live enterprise systems.

### 5. Establish a product-specific visual system

Use the actual domain, users, artifacts, vocabulary, and risk level to choose layout, type, color, density, and motion. Avoid generic AI gradients, oversized empty cards, decorative robot imagery, and a dashboard made from interchangeable tiles.

Give the product one clear visual signature. Keep body text readable, controls consistent, keyboard focus visible, contrast sufficient, and motion respectful of reduced-motion preferences. Check desktop and narrow layouts.

## Quality gate

Reject the result if any statement is true:

- The product is only a chat box with canned replies.
- Users cannot see the active goal, plan, progress, or completion standard.
- Tool use is hidden or dumped as unstructured logs.
- Permissions and human gates are absent or decorative.
- Results lack inspectable files, evidence, or validation.
- Failure, retry, resume, and handoff are not represented.
- The prototype claims real integrations it does not have.
- The main scenario cannot be completed by clicking through the prototype.
- The visual design could be reused unchanged for an unrelated product.

Before delivery, run the main, gate, and failure paths; inspect the rendered page; and map every acceptance criterion to an observable state or artifact.
