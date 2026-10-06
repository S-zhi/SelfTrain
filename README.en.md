# SelfTrain

English | [简体中文](README.md)

A single-user, local learning tool: import externally generated JSONL questions, answer them one at a time under a per-question deadline, and track first-attempt results separately from spaced review. It does not call an AI service or require an account or API key.

![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522.12-339933)
![React](https://img.shields.io/badge/React-19-149eca)
![SQLite](https://img.shields.io/badge/SQLite-local-4479a1)
![macOS](https://img.shields.io/badge/macOS-verified-697b87)

## Implemented

- Atomic import of four-choice JSONL questions, up to 5,000 non-empty question lines per import (blank lines do not count); identical IDs/content are skipped and conflicts never overwrite history.
- Sessions target 30 questions, shown one at a time with individual deadlines that survive reloads and tab changes.
- Due reviews first, then random new questions; shuffled choices and answer explanations after submission.
- Initially correct questions get one spaced review. Wrong, timed-out, or abandoned questions recur until a later correct response.
- Persistent local SQLite data, separate first-attempt/review scores, topic/day statistics, and attempt history.
- Complete JSON backup and replacement restore; invalid backups leave existing data untouched.

## Documentation

- [Question JSONL specification](docs/QUESTION_FORMAT.md)
- [Prompt for an external question-generation agent](docs/AGENT_PROMPT.md)
- [30 Go example questions](examples/go-syntax.jsonl)
- [Confirmed first-release requirements](docs/REQUIREMENTS.md)
- [Uiverse sources and MIT notices](THIRD_PARTY_NOTICES.md)

## Quick start

Requires Node.js 22.12 or newer and npm. Verified on macOS with Node.js 25.9 and Go 1.25.5; Go is not required to run the app. From the project root, install dependencies:

```bash
npm install
```

Start development mode:

```bash
npm run dev
```

Open **http://127.0.0.1:5173**. In the import page, import the bundled Go examples or choose your own `.jsonl` file, then start a session from the dashboard. The application UI is in Chinese.

Check backend health:

```bash
curl http://127.0.0.1:8787/api/health
```

A successful response is `{"ok":true}`.

### Built, single-service mode

```bash
npm run build
```

```bash
npm start
```

Open **http://127.0.0.1:8787**. Vite is not needed in this mode. The running app does not rely on external fonts, images, or AI APIs.

## Answering and review rules

1. Filter by language/topic before starting. Reviews are ordered by earliest due time; random new questions fill the remainder up to 30. Fewer eligible questions end the session normally. A question never repeats within the same session.
2. The deadline starts when the current question is shown. The server's stored deadline determines whether submission is on time. A timeout is distinct from a wrong selection, but both count as unsuccessful attempts. If timeout synchronization is briefly interrupted by the network, the app retries automatically; timeout status still follows the deadline recorded by the server.
3. Submission stops the timer and shows the result, the correct letter in the displayed choice order, and the explanation. Click the next-question button to continue.
4. Only one session can be active. Reopening restores its question/deadline. Stale actions from another tab are rejected, then the app synchronizes the latest session instead of applying an old selection to a new question. If reading a finished session's summary fails, you can retry.
5. Ending early records the currently displayed, unanswered question as abandoned. Questions that were never opened do not count. Submitted records are retained.

| Stage | Result | Next state |
| --- | --- | --- |
| New question, first attempt | Correct | One review after the interval |
| New question, first attempt | Wrong / timeout / abandoned | Repeated-review queue |
| Review after an initially correct response | Correct | No further recurrence |
| Any review | Wrong / timeout / abandoned | Schedule another spaced review |
| Repeated review | Correct | No further recurrence |

The global interval defaults to a **rolling 24 hours** and accepts 1–720 hours, measured from the recorded completion time. Changing it affects future schedules, not due dates already stored.

First-attempt accuracy counts only a question's first attempt. Reviews have their own denominator. Timeouts and abandoned attempts are unsuccessful; unopened questions are excluded. Average duration includes recorded attempts in that phase. Daily statistics use the server machine's local date. The history page displays the most recent 100 attempts, 30 dates with activity, and 12 sessions; the database and backup retain the complete history.

## Data and configuration

The default database is **`data/selftrain.sqlite`**, created on first launch. Browser and service restarts retain results. `data/`, dependencies, and build output are in `.gitignore`.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `SELFTRAIN_DATA_DIR` | No | `data/` under the project root | SQLite data directory |
| `SELFTRAIN_PORT` | No | `8787` | Local API / built-page port; takes precedence over `PORT` |
| `PORT` | No | Unset | Built mode accepts a runtime-assigned port; development mode ignores it |
| `NODE_ENV` | No | Development mode | `npm start` sets `production` to serve the built frontend |

To use a separate directory:

```bash
SELFTRAIN_DATA_DIR=/absolute/path/to/selftrain-data npm run dev
```

The development Browser preview in `.claude/launch.json` uses **`data/preview/`**, and the built-mode verification preview uses **`data/production-check/`**. Both are separate from the default personal-learning database used by direct npm commands. Demo attempts do not pollute the default database.

### Backup and restore

Download a complete JSON backup from the data/settings page. It includes questions, complete attempt history, review state, finished sessions, and settings. Restore it on another instance to move computers. Finish the active session before backup or restore.

Restore **replaces**, rather than merges, all current data and requires confirmation. Export the current state first. Before replacement, the server validates format/version, content hashes, choice permutations, references, the first-attempt-to-review phase order, and session progress and time consistency. Valid version 1 backups remain supported. Any write failure rolls back. Do not edit backups manually; the restore limit is 50 MB.

Do not copy only the `.sqlite` file while the service is running and omit SQLite's WAL files; use the application backup instead.

## Architecture

React/Vite renders the UI. Fastify handles imports, scheduling, deadlines, and grading. `better-sqlite3` persists every state. When a question opens, the server saves its choice permutation and absolute deadline. Attempt recording and review scheduling share one transaction. Before submission, the answer API does not reveal the correct choice or explanation.

```text
src/                   Pages, accessible choice controls, and styles
server/                Local service and SQLite schema
server/domain/         Import, scheduler, sessions, statistics, backup
shared/                Question contract and shared API types
examples/              30 Go sample questions
docs/                  Format guides and confirmed requirements
tests/                 Domain, API, and UI tests
```

Key controls adapt components from Uiverse's official public repository, preserving authorship and MIT notices while adding semantic radios and keyboard focus missing from the original snippets. See [third-party notices](THIRD_PARTY_NOTICES.md).

## Development verification

Run tests:

```bash
npm test
```

Type-check and build the frontend:

```bash
npm run build
```

Tests use in-memory/temporary SQLite and controlled clocks; they do not wait 24 hours or change the production interval policy. Checks cover atomic import rollback and the non-empty-line limit, review transitions, timeout sync retries, API conflict responses, separated scoring, backup phase/session/time integrity and recovery, and UI interactions.

## Limits and safety

- **The generating agent's answer is trusted.** Only JSONL structure is validated. Runtime code execution, question invalidation, and answer editing are not provided. A wrong reference answer may recur and affect statistics; this is an explicit first-release limitation.
- Four-choice single-answer questions only. No multiple-answer questions, code execution, built-in AI generation, login, or cloud sync.
- The service binds only to `127.0.0.1`, rejects external Host/Origin writes, does not execute Markdown HTML, and does not automatically load remote images embedded in questions. **Do not expose this unauthenticated service publicly.**
- Backups contain all learning content and history. Treat them as private files.
- Persistence is local, not an automatic off-device backup. Export backups regularly.

## Project and release information

The current package version is `0.1.0`. This new local project has no remote repository, GitHub Releases, or CI. Public contribution channels, maintainer contact, a private security-disclosure address, and a release workflow need user input. A project-level license also needs to be selected before external distribution; Uiverse's MIT notice does not license the entire project.

If the project becomes public, disclose security issues privately; do not publish exploit details or learning backups in public issues.
