# Forge Local Agent

Forge v2 adds the transactional local-model coding loop to a Code-OSS workbench.
It detects Ollama, LM Studio, and llama.cpp on loopback, creates a bounded task
plan, gathers fresh evidence for each task, stages mutations away from the live
workspace, validates them, and promotes only verified changes.

The Forge Agent chat opens in the Secondary Side Bar. Its compact bottom
composer contains local runtime/model selection, Auto Agent mode, an Autopilot
switch, context shortcuts, and the send action. Auto Agent routes CHAT / CREATE /
FIX / RESEARCH / LEARN through weighted signals, a local classifier fallback,
and a clarification stop for low-confidence or near-tied requests. Runtime/model discovery also
works in Restricted Mode, while repository inspection, validation, and mutation
remain locked until the folder is trusted. The extension launches the bundled
Forge sidecar locally; prompts and source code are not sent to a cloud service.

The chat displays planner and task progress, classified repair attempts, and
final aggregate verification. When a run suspends for risk, blocked context, or
failed verification, its card offers Approve, Retry with guidance, and Discard;
resume always starts from a fresh workspace snapshot rather than jumping into a
stale promotion step.

Every Forge response is an independent collapsible card. Assistant and review
answers render safe Markdown, including headings, lists, quotes, links, inline
code, and fenced code blocks with a Copy action. Use the double-arrow button in
the composer toolbar to collapse or expand all response cards.

Read-only review, analysis, audit, and recommendation requests use a source-only
snapshot and return findings without entering Apply. Explanations stay in Chat;
CREATE and FIX requests delegate to the bounded transactional loop.
Generated, vendored, release, discussion, profile, and transient locked paths
are excluded from repository research and staging.
