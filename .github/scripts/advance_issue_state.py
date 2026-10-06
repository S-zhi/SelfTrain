#!/usr/bin/env python3
"""Move an Issue to its next configured state after its action is released."""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote

from sync_labels import FAILED_STATE, ValidationError, load_and_validate


def plan_transition(event: dict, live_labels: list[str], states: list[str]):
    """Return (label_to_add, label_to_remove, explanation)."""
    action = event.get("action")
    if action == "opened":
        if any(label.startswith("state:") for label in live_labels):
            return None, None, "Issue already has a state label"
        if any(label.startswith("action:") for label in live_labels):
            return None, None, "Issue already has an action label"
        return (states[0], None, "Initialize issue") if states else (None, None, "No states configured")

    if action != "unlabeled" or not isinstance(event.get("removed_label"), str):
        return None, None, "Unsupported issue event"
    if not event["removed_label"].startswith("action:"):
        return None, None, "Removed label is not an action label"

    snapshot = event.get("snapshot_labels", [])
    if not isinstance(snapshot, list) or any(not isinstance(label, str) for label in snapshot):
        return None, None, "Invalid event label snapshot"
    snapshot_states = [label for label in snapshot if label.startswith("state:")]
    live_states = [label for label in live_labels if label.startswith("state:")]
    if any(label.startswith("action:") for label in snapshot + live_labels):
        return None, None, "Issue still has an action label"
    if len(snapshot_states) != 1 or snapshot_states != live_states:
        return None, None, "Event snapshot and live state disagree"

    current = live_states[0]
    if current == FAILED_STATE or current not in states:
        return None, None, f"Issue is paused or has an unsupported state: {current}"
    next_index = states.index(current) + 1
    if next_index >= len(states):
        return None, None, "Issue is at the final state"
    return states[next_index], current, "Advance to next state"


def run_gh(args: list[str]) -> str:
    result = subprocess.run(["gh", "api", *args], check=True, capture_output=True, text=True)
    return result.stdout


def normal_states() -> list[str]:
    labels = load_and_validate(Path(".github/label.yaml"))
    return [item["name"] for item in labels if item["name"].startswith("state:") and item["name"] != FAILED_STATE]


def main() -> int:
    parser = argparse.ArgumentParser(description="Advance a SelfTrain issue through its configured states")
    parser.add_argument("--issue-number", required=True, type=int)
    args = parser.parse_args()
    if args.issue_number <= 0:
        parser.error("--issue-number must be positive")

    try:
        event_path = os.environ.get("GITHUB_EVENT_PATH")
        repo = os.environ.get("GH_REPO") or os.environ.get("GITHUB_REPOSITORY")
        if not event_path or not repo:
            raise ValueError("GITHUB_EVENT_PATH and GH_REPO are required")
        with open(event_path, encoding="utf-8") as stream:
            payload = json.load(stream)
        issue = payload.get("issue")
        if not isinstance(issue, dict) or issue.get("number") != args.issue_number:
            raise ValueError("Issue number does not match the GitHub event")

        endpoint = f"repos/{repo}/issues/{args.issue_number}"
        live_issue = json.loads(run_gh([endpoint]))
        if live_issue.get("state") != "open":
            print("Issue is not open; skip")
            return 0
        live_labels = [label["name"] for label in live_issue.get("labels", [])]
        event = {
            "action": payload.get("action"),
            "removed_label": (payload.get("label") or {}).get("name"),
            "snapshot_labels": [label["name"] for label in issue.get("labels", [])],
        }
        add, remove, reason = plan_transition(event, live_labels, normal_states())
        if not add:
            print(f"Skip: {reason}")
            return 0

        run_gh([f"{endpoint}/labels", "--method", "POST", "-f", f"labels[]={add}"])
        print(f"Added {add}: {reason}")
        if remove:
            run_gh([f"{endpoint}/labels/{quote(remove, safe='')}", "--method", "DELETE"])
            print(f"Removed previous state {remove}")
        output_path = os.environ.get("GITHUB_OUTPUT")
        if output_path:
            with open(output_path, "a", encoding="utf-8") as stream:
                stream.write("state_changed=true\n")
        return 0
    except (OSError, json.JSONDecodeError, ValidationError, ValueError, KeyError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or exc.stdout or "").strip()
        print(f"Error: gh api failed (exit {exc.returncode}): {detail}", file=sys.stderr)
        return exc.returncode or 1


if __name__ == "__main__":
    raise SystemExit(main())
