# Agent, benchmark and live supervision readiness — 2026-10-17

The implementation foundation exists, but a passing mock demo is not sufficient evidence for a safe, accurate live benchmark. This audit found concrete runtime and measurement gaps. Fix the baseline privacy bypass before sensitive runs, and fix provenance/quality scoring before relying on benchmark savings.

Scope: current source/configuration inspection, passive local-service checks, offline checks and synthetic in-memory reproductions. No paid model completion, live ACP task, hosted browser session or external app action was launched. Credentials were inspected only for presence and non-secret configuration. Runtime code and `.env` were not changed.

## Progress delivered

| Capability          | Current implementation                                                                                                                                                                                   | Verification boundary                                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Agent runtime       | Hermes subprocess over ACP, scoped model/MCP gateways, trusted tool registry/broker, per-action authorization, pause/resume/cancel, SSE trace                                                            | Checkout and dependencies present; offline single-run/credential checks pass. A real task was not launched today.                |
| Browser supervision | Environment-selected Browserbase/Browserless/local adapters; agent-created and pooled browser sessions publish to SSE; shared watch/take-control/Done UI; ownership revisions, drain, revoke and cleanup | Offline browser tool/integration/HTTP checks pass. Hosted session/viewer/site compatibility still requires rehearsal.            |
| Tool supervision    | Shared Action workspace, exact payload/account review, approve/revise/reject, transient previews and distinct proposed/provider-reported/readback evidence                                               | Local artifact and mock tool checks pass. Composio API receipts are not a live Office screen or call media stream.               |
| Change verification | Actual versioned local Markdown and JSON cell-grid writes, bounded diffs and independent local readback                                                                                                  | These are local artifacts, not Word/Excel application sessions. Cloud Office readback adapters are absent.                       |
| Benchmarking        | Paired graph/B0/B1 launches, repeat-run CLI, JSON export, outcome assertions, token/cost/active-time rollups, comparison and aggregate pages                                                             | Measurement code runs, but the validity/safety findings below prevent treating all current results as credible live comparisons. |

Current browser-session propagation is in [runtime.ts](../apps/api/src/services/runtime.ts:86); sessions are visible during agent execution in [Workspace.tsx](../apps/web/src/pages/Workspace.tsx:877). A graph browser node is no longer required just to reveal an agent-opened browser.

## Current local setup

Resolved from the current root configuration on October 17; key presence does not prove validity, model availability or quota.

| Setting                                     | Observed state                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `MOCK_ALL`                                  | `false`                                                                                                 |
| Hermes, Jev, Browserbase, Anthropic, Gemini | Configured live; relevant keys/Browserbase project present                                              |
| Preferred browser                           | `browserbase`                                                                                           |
| Composio                                    | Mock, although a project key is present; current OAuth/tool availability was not queried                |
| `web.search`                                | Mock, backend `browser`; explicit `browserbase.search/read` are separate tools                          |
| Browserless                                 | Mock; key absent                                                                                        |
| Local browser / Ollama                      | Mock; no Ollama listener found                                                                          |
| Model/browser credential source             | Both explicitly `operator`; stored user keys are not selected until the corresponding source is changed |
| Persistence                                 | `PERSIST_TO_DISK=true`                                                                                  |
| Pricing overrides                           | `MODEL_PRICES_JSON` absent                                                                              |
| Hermes installation                         | Checkout exists; `hermes-agent 0.21.3`, ACP entrypoint and ACP/MCP modules present; `uv` on PATH        |
| Agent limits                                | Five-minute duration, eight tool calls per gateway turn, two network retries                            |
| Running services                            | No listeners found on API `8787`, web `5173`, or Ollama `11434` during the scan                         |

BYOK is implemented, but this checkout is currently configured to use operator model and browser credentials. Gemini BYOK alone does not cover workflow authoring: `text.model` and the synthesis service are bound to Anthropic. User-funded model inference, cloud browser time, Composio project access and OAuth accounts remain separate resources.

## Fix before sensitive runs or credible live benchmarks

### P0 — pinned baseline bypasses model privacy eligibility

[ModelGatewayService](../apps/api/src/core/modelGateway/service.ts:278) chooses a cloud frontier route for a pinned session before applying `eligibleModelRoutes`, bypassing the ordinary `DecisionService.selectModel` path. There is no independent label check before backend dispatch. [B1 sets this pin](../apps/api/src/core/orchestrator.ts:981).

Six offline cases reproduced the boundary: for each of `private`, `secret` and `local_only`, the normal eligibility function returned zero cloud routes. Unpinned requests made zero backend calls and stopped. Pinned requests made one call to an injected cloud backend, which received the synthetic sensitive marker. No real network egress occurred.

Required change: apply hard privacy/credential/tool eligibility before every route selection, including pins, and recheck before dispatch. A missing eligible frontier route should make B1 unavailable, not silently switch to ordinary Jev routing. B0's deliberately unredacted direct cloud path also needs a clear public-only boundary before sensitive comparisons.

### P1 — benchmark auto-approval can approve a first live action

[The repeat-run CLI](../apps/api/scripts/benchmark.ts:109) treats zero historical live egress rows as proof that a run is mocked. Before the first provider execution, a real pending write can satisfy that condition. This does not prove the proposed action is simulated.

Do not use `--approve` for live rehearsals. Required change: bind automation of approvals to trusted explicit mock execution provenance for the pending action/run, or remove this shortcut. Absence of past traffic is not authorization.

### P1 — mixed real-model/mock-tool runs can enter live-only reports

[Mock search](../apps/api/src/core/tools/search.ts:172) returns simulated evidence without writing a mock egress row. [Benchmark classification](../packages/shared/src/benchmark.ts:132) checks only egress to decide whether a sample is mocked.

An in-memory reproduction used the actual mock search executor: `executionMode=mock`, `simulated=true`, zero search egress rows, `sample.mocked=false`; the default live-only report retained the sample. Some agent toolsets remove mock twins when live equivalents exist, but explicit graph calls and other mixed configurations remain reachable.

Required change: propagate trusted tool/model execution provenance into run/benchmark classification and exclude any simulated dependency from live results. A live model does not make its mock search evidence real.

### P1 — default quality scoring is not equivalent across arms

[The demo graph](../apps/api/src/core/graph/demo.graph.ts:208) asserts its internal redaction-span count. Baseline task construction omits pipeline-only fields from requested answers, but [baseline scoring](../packages/shared/src/benchmark.ts:55) still evaluates all graph assertions. Baselines can therefore fail by construction. Assertion paths are also flattened to their final field, allowing collisions between different nodes.

Required change: distinguish outcome assertions from pipeline assertions, score identical task outcomes across arms and preserve unique answer identities. Use a public, read-only fixture with a known answer; `graph_demo` is currently a system demonstration, not a fair default quality benchmark.

### P1 — uncertain browser targets still execute

[The browser executor](../apps/api/src/core/tools/browser.ts:338) explicitly follows Jev's target selection at any confidence. Earlier broker authorization cannot escalate an uncertain target chosen afterward. This conflicts with the repository's low-confidence escalation requirement.

Required change: ambiguous targets should stop/escalate to human selection or handoff instead of clicking or typing speculatively. Separately, [direct browser research](../apps/api/src/core/tools/browser.ts:435) accepts empty/challenge text as successful extraction and marks execution verified; it lacks `web.search`'s challenge detection. Add blocked-page detection and task-level evidence verification.

### P1/P2 — completion semantics can overstate task success

[The current controller](../apps/api/src/core/orchestrator.ts:1347) records Jev's completion verdict but continues the graph even when that verdict is blocked/unverified. This is intentional in the current single-run checks and differs from the design document's verified-done/continue/blocked lifecycle. With no assertions, benchmark success falls back to the run's `succeeded` status.

Decide and enforce one completion contract: a returned harness result must not imply that the requested outcome was achieved. Preserve partial results, but surface blocked/unverified completion and prevent it from counting as benchmark success without equivalent outcome verification.

## Other measurement gaps

- [Pairing](../packages/shared/src/benchmark.ts:245) uses graph ID plus pair ID/time without enforcing the same graph version, task, inputs, model/tool configuration or assertions. Freeze these values and record an experiment fingerprint.
- Baseline prompts reconstruct original conversation/description/inline sources, not every manually edited node instruction. Keep a canonical task statement shared by all arms.
- The Graph Editor's comparison launch hardcodes demo variables; custom inputs are available in the CLI. [GraphEditor.tsx](../apps/web/src/pages/GraphEditor.tsx:179).
- The CLI defaults to graph versus B0, which has no tools. Include `baseline_agent` explicitly for the real agent-versus-agent comparison.
- [Paired savings](../packages/shared/src/benchmark.ts:284) includes samples with unpriced model calls. Fully price both arms or withhold exact savings percentages. Gemini/Jev costs may be incomplete without provider-reported cost or configured rates. Browser/Composio service fees are not comprehensive billing totals.
- Arms launch concurrently and share rate/session limits and target resources. Prefer read-only tasks; mutation experiments need equivalent isolated fixture copies.
- JSON export is in CLI `--out`; no UI export control was found. Compare links to each run for live viewing/approvals rather than embedding the control panel itself.

## Remaining live-view and operational limits

- Browserbase's saved HTTP 402/quota failure is from **October 5**; it was not re-tested today. Live health checks configuration and cannot establish successful browser creation or current site access.
- Browserless has no configured key and no hosted rehearsal. Its configured default two-minute session timeout is shorter than a default ten-minute handoff. Align provider/account limits, viewer expiry and measured task duration before switching.
- Lost Browserless automation transport does not restore the same live page. Dashboard viewer refresh while the transport remains open is a different capability.
- The live browser fallback inside `web.search` opens/closes a disposable session without browser-session announcements. It produces an activity/result card, not a retained watchable browser. Explicit browser opens and pooled `browserbase.search/read` are the watchable path.
- Graph handoff blocks its branch/browser resource; independent graph branches may continue. User-requested Take control pauses the broader run. Document that distinction or add an explicit broader handoff pause contract.
- `url_matches` is checked when the user clicks Done; there is no automatic URL-triggered continuation watcher.
- Browserless is missing from the gateway/MCP separate-session filtering helpers, although final broker resource binding still blocks incompatible calls. This can produce avoidable failed tool selections.
- Normal private app-read-to-summary workflows require an eligible local model because current cloud routes are public-only. Ollama is not running/configured live. The pinned-baseline exception above must be fixed first; it is not an acceptable workaround.
- [The legacy live smoke script](../scripts/live-check.mjs:33) does not establish/send the local control cookie, so its run-creation POST conflicts with the authenticated API. Update the harness before using `pnpm smoke:live` as proof.
- Composio shows exact proposals/account identity and provider receipts. Independent cloud Office readback, rendered Office screens and call audio/video are not implemented. Native local document/grid artifacts do have verified local readback.

## Checks performed today

All of these passed offline:

- `pnpm typecheck`.
- `pnpm check:agent-single-run`, `pnpm check:credentials`.
- `pnpm check:authoring-mock` — three authored workflows and a separately reviewed local draft.
- `pnpm check:action-workspace`.
- Browser tool, integration and HTTP checks; no hosted browser call or new local Chrome rehearsal.
- `pnpm --filter @htn/api check:benchmark` — 24 checks.
- `pnpm --filter @htn/web test` — 44 tests.

The privacy and mock-provenance reproductions above are additional audit observations, not claims that the existing test suite catches those failures. A full paid live run, hosted viewer/target-site rehearsal and current aggregate benchmark results were not verified. The previous seven-scenario UI/hosted-limit report remains dated October 5.

## Path to a trustworthy demonstration

1. Fix pinned-route privacy, approval automation, mock provenance, equivalent outcome scoring and blocked/uncertain completion behavior. Add regression coverage for the reproduced cases.
2. Choose a public read-only task with a known answer. Freeze task, variables, graph/config versions and shared outcome assertions. Configure the intended real browser/search/tool modes; require real local inference for private workflows.
3. Start `pnpm dev`, check Connections for effective modes/health, then submit through **Run as agent task**. Open the run's browser card to watch/control it; use the action cards for tool payloads and approvals. Verify one complete harmless real run before measuring repetitions.
4. Confirm live model IDs, keys, browser quota, source-page access and actual tool connection. Validate watch, takeover, manual input, Done and same-session continuation against the provider being demonstrated.
5. After the fixes, run graph/B0/B1 repeatedly on equivalent inputs, approve live actions manually, inspect actual selected models/provenance, and export samples plus report. Do not report savings until both arms pass the same outcome check and the relevant costs are known.

Example after the preceding fixes and fixture preparation; replace `YOUR_READ_ONLY_GRAPH_ID` with the saved graph ID:

```powershell
pnpm --filter @htn/api benchmark -- --graph YOUR_READ_ONLY_GRAPH_ID --arms graph,baseline,baseline_agent --repeats 5 --out benchmark-results.json
```

Use the graph comparison controls for a single paired run, the run links for live intervention, and `/benchmarks` for aggregate measurements. Keep mock rehearsal results separate from live benchmark evidence.
