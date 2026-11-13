# omp-task reference

`omp-task` wraps the `omp --mode rpc` calls used by `bin/omp-call.mjs` in
tracked, resumable, cancellable tasks. Each task gets a directory containing
status, events, prompts and the final reply. The process stays in the
foreground until finished; the Bot launches it using its Shell tool's
background mode.

- Node 22+, no third-party dependencies.
- Tested against **OMP 18.18.9**; requires `prompt_result`, `negotiate_protocol`,
  `get_state`, and the extension `tool_call` hook.
- Default: OMP's configured default model (or `OMP_TASK_MODEL`), thinking
  `medium`, read/write/exec and web tools.
- IDs: `<session>-<YYYYMMDD-HHMMSS>`; timestamps are stored as ISO UTC and IDs
  use the host's local timezone.
- Owner identifies the dispatching Bot; `pending`/`list`/`ack` support owner
  filters.
- The wrapper does not read OMP credential stores; OMP handles model
  authentication itself.

## Usage

Commands below assume `omp-task` is installed on PATH; otherwise use
`~/tools/omp-call/omp-task`. Angle-bracket arguments are placeholders to
replace.

```text
omp-task run <cwd> "<prompt>" --session <name> --owner <agent-id> [--timeout sec]
            [--idle-timeout sec] [--model provider/model]
            [--thinking off|minimal|low|medium|high|xhigh|max|auto]
            [--notify-prefix <name>] [--no-write] [--no-web] [--guard on|off]
omp-task reply <ID> "<prompt>" [--owner <agent-id>] [--timeout sec] [--idle-timeout sec]
omp-task approve <ID> <req> [--owner <agent-id>] [--timeout sec] [--idle-timeout sec]
omp-task deny <ID> <req> [--owner <agent-id>] [--timeout sec] [--idle-timeout sec]
omp-task status <ID>
omp-task list [--all] [--owner <agent-id>|none]
omp-task log <ID> [-n 30]
omp-task cancel <ID>
omp-task pending [--owner <agent-id>|none]
omp-task ack <ID> [<ID>...] [--owner <agent-id>|none]
```

Timeout defaults to 300 seconds; `0` disables it. Session-name whitespace and
path separators are normalized to hyphens. `reply` reuses the original OMP
session, working directory, owner and options; it does not accept `--owner`
changes (only an owner check).

If failure/cancellation happens before any assistant text, `result.md` is
absent or contains the previous run's text.

```bash
OMP_TASK_DIR=/tmp/tasks ~/tools/omp-call/omp-task run ~/repo \
  "Fix typos in README" --session docs --owner YOUR_AGENT_ID
# TASK docs-20261018-151601
# STATE done
# RESULT /tmp/tasks/docs-20261018-151601/result.md

OMP_TASK_DIR=/tmp/tasks ~/tools/omp-call/omp-task reply docs-20261018-151601 \
  "Also add a usage example"
```

For long jobs, launch `run` in the host's background mode, retain the TASK ID,
and later:

```bash
~/tools/omp-call/omp-task pending --owner YOUR_AGENT_ID
~/tools/omp-call/omp-task status TASK_ID
# Read result.md and verify artifacts/diff/tests; report to the user first.
~/tools/omp-call/omp-task ack TASK_ID --owner YOUR_AGENT_ID
```

## Ownership

Owner is the dispatching Bot's agent ID, obtainable from its profile location,
for example `/home/box/agent-data/agents/YOUR_AGENT_ID/profile.json`.

- `run --owner` records a string in `status.json`.
- Without the flag, `run` reads `OMP_TASK_OWNER`. Without either, owner is null
  and stderr warns:
  `omp-task: warning: --owner was not specified; completion cannot be routed to the dispatching Bot`.
- Invalid/empty owner arguments are rejected; `run` rejects whitespace in an owner.
- `reply` cannot change owner; `approve`/`deny` accept `--owner` as a guard.
- For filtering, `--owner none` selects null/missing owners. Do not use the
  literal string `none` as a Bot ID.

| Command | No owner filter | --owner ID | --owner none |
| --- | --- | --- | --- |
| pending | All terminal, unreported tasks | Matching owner only | Unowned tasks only |
| list | All running/recent tasks | Matching owner only | Unowned tasks only |
| ack | Acknowledges all supplied IDs without an ownership check | Refuses mismatched owners | Refuses non-null owners |

Old records lacking owner are treated as unowned. For a multi-ID ack, matched
records are still acknowledged even if others are refused; any refusal yields
exit code 1. Always use your owner filter when acting as a Bot. Ownership is
routing discipline, not an operating-system security boundary.

List/pending output includes `owner=<id|->`; a hyphen means unowned:

```text
news-i18n-20261018-152233  owner=YOUR_AGENT_ID  done  runs=1  created=21m ago
```

## Notification

Read order:

1. `--notify-prefix NAME` → `NAME_OMP_NOTIFY_URL` + `NAME_OMP_NOTIFY_KEY`
2. otherwise `OMP_TASK_NOTIFY_PREFIX`
3. otherwise `OMP_NOTIFY_URL` + `OMP_NOTIFY_SECRET`
4. `OMP_NOTIFY_OFF=1` or a missing URL/key → skip

Completion payload:

```json
{"source":"omp-task","id":"docs-20261018-151601","owner":"YOUR_AGENT_ID","state":"done","exit_code":0}
```

Approval payload:

```json
{"source":"omp-task","id":"TASK_ID","owner":"BOT_ID","state":"needs_approval","exit_code":null,"req":"REQ_ID","command":"rm -rf /"}
```

Neither payload contains the prompt or result. The notifier is a detached Node
process; it receives the Bearer secret via environment (`Authorization: Bearer
<key>`), never via argv. Notification URL/secret and `*_OMP_NOTIFY_*` variables
are removed from the OMP child's environment. Notification attempts are logged
as `notify` events (`http 200`, `error ...`).

## Storage

Root: `$OMP_TASK_DIR`, default `~/.omp/tasks`. Each task has its own `<ID>/`
directory.

| File | Contents |
| --- | --- |
| status.json | State, written atomically using a temporary file and rename |
| events.jsonl | Events with ts/type/tool/text; text is normalized to one line and truncated to 500 characters |
| result.md | Last assistant text, absent if no text was produced |
| prompt-N.txt | Prompt for turn N |
| approvals.jsonl | Guard interception requests `{req,command,reason,ts}` |
| approved.json | Commands the user approved for this task (exact string match) |

Example status:

```json
{
  "id": "docs-20261018-151601",
  "session": "docs",
  "owner": "YOUR_AGENT_ID",
  "cwd": "/home/me/repo",
  "model": "provider/model",
  "state": "done",
  "pid": null,
  "created_at": "2026-10-18T07:16:01.650Z",
  "started_at": "2026-10-18T07:16:01.652Z",
  "ended_at": "2026-10-18T07:16:03.541Z",
  "exit_code": 0,
  "error": null,
  "reported": false,
  "session_file": "/home/me/.omp/agent/sessions/tasks/2026-10-18T07-16-01-640Z_01a1....jsonl",
  "omp_session_id": "01a1....",
  "runs": [
    {"n": 1, "prompt": "Fix typos in README",
     "started_at": "...", "ended_at": "...", "exit_code": 0}
  ],
  "options": {"thinking": "medium", "write": true, "web": true, "guard": "on"}
}
```

`session_file` and `omp_session_id` are filled from the OMP `get_state` RPC
response after the first spawn. `reply` / `approve` / `deny` resume with
`--resume`, preferring an existing `session_file` and falling back to
`omp_session_id` (OMP accepts a path or id/prefix). If the file is gone a
`session_missing` event is recorded; if neither target is usable the command
**fails hard** instead of silently starting a cold session that would lose
context.

Reply reuses options from the first run. Storage timestamps are ISO UTC;
displayed timestamps and ID generation use the host process's local timezone.
`status` prints a human-readable summary; inspect `status.json` to see
`exit_code` directly.

## States and exit codes

States: `queued`, `running`, `done`, `failed`, `cancelled`, `interrupted`.

| Exit code | Meaning |
| --- | --- |
| 0 | done |
| 1 | failed, refusal, or command error; task failures record error |
| 2 | Usage error, such as missing arguments or invalid timeout |
| 124 | Timeout: failed with error="timeout" |
| 130 | cancelled |

On timeout or SIGTERM/SIGINT, the runner sends `abort` to OMP, allows up to five
seconds, then records the outcome and exits. A second signal ends immediately.

Operational subcommands perform an orphan check: a task recorded as `running`
whose PID no longer exists is marked `interrupted`, with an `orphan_detected`
event. This handles, for example, a runner killed with SIGKILL or lost during a
restart.

`cancel` signals `status.pid` (the omp-task runner, not the OMP child). If it has
not finished after 12 seconds, `cancel` sends SIGKILL and records forced
cancellation.

Only one `running` or `queued` task is allowed per session. `run` with an
occupied session and `reply` to a running task are refused with exit code 1.

## OMP RPC adaptation

The task runner speaks OMP's native RPC mode. The relevant contract:

| Topic | Implementation |
| --- | --- |
| Start | `spawn(OMP_BIN \|\| "omp", ["--mode","rpc", ...])`, cwd = task cwd |
| Ready | Waits for the first `{"type":"ready",...}` frame |
| Protocol | Sends `negotiate_protocol` v2 when advertised; reassembles `rpc_chunk` frames; falls back to v1 |
| Session | Fresh run uses `--session-dir $OMP_TASK_SESSION_DIR`; follow-ups use `--resume <session_file\|omp_session_id>` |
| Prompt | `{"id","type":"prompt","message":"..."}` |
| Completion | `prompt_result` keyed by prompt id; `agentInvoked:false` finishes local/slash turns; `agent_end` with `isTerminal !== false` is a watchdog; agent turns require assistant text (or fail) |
| Abort | `{"type":"abort"}`; waits up to 5s for the outcome |
| Resume | `reply`/`approve`/`deny` send a new prompt in the same resumed session |
| UI requests | `select`/`confirm`/`input`/`editor`/`ask` are answered `extension_ui_response {cancelled:true}`; one-way `setWidget`/`notify` frames are ignored |
| stderr | Never mixed into JSONL parsing; kept for diagnostics and failure messages |
| Guard | OMP is started with `-e <omp-guard.ts>` unless `--guard off` or `OMP_GUARD=off` |
| Model | `--model provider/model`, or `OMP_TASK_MODEL`; empty means OMP default |
| Thinking | Passed through to `--thinking`; default `medium` (`OMP_TASK_THINKING`) |

### Tool mapping

OMP's tool catalog differs from Pi's. `omp-task` maps the GAP intent as follows:

| Mode | `--tools` |
| --- | --- |
| write + web (default) | `read,bash,edit,write,glob,grep,todo,wait,web_search` |
| write, `--no-web` | `read,bash,edit,write,glob,grep,todo,wait` |
| `--no-write` + web | `read,glob,grep,web_search` |
| `--no-write --no-web` | `read,glob,grep` |

`eval` and `task` (subagents) are deliberately excluded: `eval` can execute code
without passing through the bash guard, and subagents would run outside the
task's guard/approval loop. The host also passes `--auto-approve` so OMP's own
interactive tool prompt cannot hang a headless run; `omp-guard` remains the
safety net.

## Preflight

If `OMP_TASK_PREFLIGHT` points to an executable, or an executable `omp-preflight`
sits beside `omp-task`, it runs synchronously before `run`/`reply`/`approve`/
`deny` spawns OMP. A non-zero exit is logged but does not block the task.

When OMP emits `auto_retry_start` for a connection-class error (`UND_ERR_SOCKET`,
`socket`, `other side closed`, `ECONNRESET`, `ETIMEDOUT`, `fetch failed`,
`connection error`, `terminated`, `network`), the runner starts preflight again
in parallel with OMP's retry. Events are recorded as `preflight` with `ok`,
`exit N`, or `started after connection error (...)`.

Template: `bin/omp-preflight.example`.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| OMP_TASK_DIR | ~/.omp/tasks | Task store |
| OMP_TASK_SESSION_DIR | ~/.omp/agent/sessions/tasks | OMP session directory for new tasks |
| OMP_TASK_OWNER | Empty | Default owner for run |
| OMP_TASK_MODEL | Empty | Default model when --model is absent (if empty, OMP uses its own default) |
| OMP_TASK_THINKING | medium | Default thinking level |
| OMP_TASK_IDLE_TIMEOUT | 300 | Default idle timeout in seconds |
| OMP_TASK_PREFLIGHT | `omp-preflight` beside omp-task, if executable | Model-path check before run/reply/approve/deny, and in parallel on connection retries |
| OMP_TASK_NOTIFY_PREFIX | Empty | Default notify prefix when --notify-prefix is absent |
| OMP_NOTIFY_URL | Empty | Webhook endpoint (used when notify prefix is not set) |
| OMP_NOTIFY_SECRET | Empty | Raw notification Bearer token (used when notify prefix is not set) |
| OMP_NOTIFY_OFF | Empty | Set to 1 to disable notifications temporarily |
| OMP_BIN | omp | OMP executable |
| OMP_GUARD | on | Set to off to bypass the guard extension |
| OMP_TASK_DIR_CURRENT | runner-injected | Current task dir exposed to the guard extension |
| OMP_TASK_HOME | ~/tools/omp-call | install.sh target |
| `<BOT>_OMP_NOTIFY_URL` | — | Multi-Bot webhook URL |
| `<BOT>_OMP_NOTIFY_KEY` | — | Multi-Bot webhook key |

Both notification variables must be present to send. Use secure input, not files
or command-line arguments, for credentials. Notification credentials are removed
from the delegated OMP child's environment; the separate notifier receives them.

## Guard and approvals

`extensions/omp-guard.ts` subscribes to OMP's `tool_call` event and blocks only
catastrophic commands. On a block it appends `{req,command,reason,ts}` to the
task's `approvals.jsonl` and returns:

```text
已请求用户放行（req=<req>），先跳过这一步继续做别的，不要换个写法绕过
```

`omp-task` polls `approvals.jsonl` every 200ms and POSTs the `needs_approval`
notification. `approve` writes the exact command to `approved.json` and resumes
the session with a release message; the guard then allows that exact string on
its next execution. `deny` resumes with a refusal message and does not whitelist
anything.

See [security.md](security.md) for the rule set and limitations.

## Compared with omp-call

- `omp-call.mjs` prints the last reply from a one-shot call. `omp-task` adds
  persistent records, follow-up, cancellation and report acknowledgment.
- `omp-task` creates sessions in `~/.omp/agent/sessions/tasks`; `omp-call`
  defaults to `--no-session` and only writes a session when `--session-dir` or
  `--resume` is given. Do not assume their sessions can be resumed
  interchangeably.
- `omp-task` defaults to write/exec tools. `omp-call` requires `--allow-write`
  for that tool set. Tool selection is not a filesystem sandbox.

For setup and notification checks, see [the setup guide](setup-guide.md).
