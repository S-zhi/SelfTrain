#!/usr/bin/env python3
"""Ask the configured reviewer which action label belongs to an Issue."""

import argparse
import json
import os
import re
import subprocess
import sys
import uuid
from pathlib import Path

import yaml
from sync_labels import FAILED_STATE, ValidationError, load_and_validate


def require_fields(value, fields: set[str], context: str) -> None:
    if not isinstance(value, dict) or set(value) != fields:
        raise ValueError(f"{context} fields do not match the expected schema")


def load_policy() -> dict:
    with Path(".github/action-policy.yaml").open(encoding="utf-8") as stream:
        policy = yaml.safe_load(stream)
    require_fields(policy, {"reviewer", "agents"}, "Policy")
    reviewer = policy["reviewer"]
    require_fields(reviewer, {"name", "model", "command", "timeout_seconds"}, "Reviewer")
    if reviewer["name"] != "TypeSafe" or not isinstance(reviewer["model"], str) or not reviewer["model"].strip():
        raise ValueError("Reviewer must be TypeSafe with a model name")
    if not isinstance(reviewer["command"], list) or any(not isinstance(item, str) or not item.strip() for item in reviewer["command"]):
        raise ValueError("Reviewer command must be a list of nonempty strings")
    timeout = reviewer["timeout_seconds"]
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not 0 < timeout <= 3600:
        raise ValueError("Reviewer timeout_seconds must be between 1 and 3600")
    if not isinstance(policy["agents"], list) or any(not isinstance(item, dict) for item in policy["agents"]):
        raise ValueError("Agents must be a list of capability objects")
    json.dumps(policy["agents"], allow_nan=False)
    return policy


def gh_json(args: list[str]):
    result = subprocess.run(["gh", "api", *args], capture_output=True, text=True, check=True)
    return json.loads(result.stdout) if result.stdout.strip() else None


def issue_snapshot(issue: dict) -> tuple[list[str], str]:
    if not isinstance(issue, dict) or not isinstance(issue.get("labels"), list):
        raise ValueError("Invalid live Issue response")
    labels = [item.get("name") for item in issue["labels"] if isinstance(item, dict)]
    if len(labels) != len(issue["labels"]) or any(not isinstance(name, str) for name in labels):
        raise ValueError("Invalid Issue labels")
    updated_at = issue.get("updated_at")
    if not isinstance(updated_at, str) or not updated_at:
        raise ValueError("Issue updated_at is missing")
    return labels, updated_at


def read_comments(endpoint: str) -> list[dict]:
    """Read all comment pages and reject incomplete context."""
    pages = gh_json(["--paginate", "--slurp", f"{endpoint}/comments?per_page=100"])
    if not isinstance(pages, list) or not pages or any(not isinstance(page, list) for page in pages):
        raise ValueError("Invalid paginated comments response")
    comments = []
    seen_ids = set()
    for page in pages:
        for item in page:
            if not isinstance(item, dict):
                raise ValueError("Invalid Issue comment")
            comment_id = item.get("id")
            if type(comment_id) is not int or comment_id <= 0 or comment_id in seen_ids:
                raise ValueError("Invalid or duplicate comment id")
            if not isinstance(item.get("body"), str):
                raise ValueError("Invalid comment body")
            if any(not isinstance(item.get(key), str) or not item[key] for key in ("created_at", "updated_at")):
                raise ValueError("Missing comment timestamp")
            user = item.get("user")
            author = user.get("login") if isinstance(user, dict) else None
            if user is not None and (not isinstance(author, str) or not author):
                raise ValueError("Invalid comment author")
            seen_ids.add(comment_id)
            comments.append({"id": comment_id, "author": author, "body": item["body"],
                             "created_at": item["created_at"], "updated_at": item["updated_at"]})
    return sorted(comments, key=lambda comment: comment["id"])


def eligible(issue: dict, normal_states: set[str]) -> tuple[str | None, str]:
    labels, _ = issue_snapshot(issue)
    if issue.get("state") != "open":
        return None, "Issue is not open"
    if FAILED_STATE in labels:
        return None, "Issue is paused in state:agent-failed"
    if any(label.startswith("action:") for label in labels):
        return None, "Issue already has an action label"
    states = [label for label in labels if label.startswith("state:")]
    if len(states) != 1 or states[0] not in normal_states:
        return None, "Issue must have exactly one supported state label"
    return states[0], ""


def review(policy: dict, request: dict) -> str:
    reviewer = policy["reviewer"]
    if not reviewer["command"]:
        raise ValueError("Reviewer command is not configured")
    result = subprocess.run(
        reviewer["command"], input=json.dumps(request, ensure_ascii=False, allow_nan=False),
        capture_output=True, text=True, encoding="utf-8", timeout=reviewer["timeout_seconds"], check=False,
    )
    if result.returncode:
        from jev_review import ERRORS
        bundled = reviewer["command"] == ["python", ".github/scripts/jev_review.py"]
        message = ERRORS.get(result.returncode, "reviewer failed") if bundled else "reviewer failed"
        print(f"Error: {message}; no action was assigned", file=sys.stderr)
        raise subprocess.CalledProcessError(result.returncode, reviewer["command"])
    response = json.loads(result.stdout)
    require_fields(response, {"protocol_version", "request_id", "issue_number", "expected_state", "decision", "reason"}, "Reviewer response")
    if response["protocol_version"] != "1" or response["request_id"] != request["request_id"]:
        raise ValueError("Reviewer response protocol does not match")
    if type(response["issue_number"]) is not int or response["issue_number"] != request["issue"]["number"]:
        raise ValueError("Reviewer response Issue number does not match")
    if response["expected_state"] != request["issue"]["state"]:
        raise ValueError("Reviewer response state does not match")
    if response["decision"] not in ("human", "agent"):
        raise ValueError("Reviewer decision must be human or agent")
    if not isinstance(response["reason"], str) or not response["reason"].strip():
        raise ValueError("Reviewer reason must be nonempty")
    return response["decision"]


def main() -> int:
    parser = argparse.ArgumentParser(description="Review and assign a SelfTrain Issue action")
    parser.add_argument("--issue-number", required=True, type=int)
    args = parser.parse_args()
    if args.issue_number <= 0:
        parser.error("--issue-number must be positive")

    try:
        repo = os.environ.get("GH_REPO") or os.environ.get("GITHUB_REPOSITORY")
        if not repo or not re.fullmatch(r"[^/\s]+/[^/\s]+", repo):
            raise ValueError("Repository must be owner/repo")
        policy = load_policy()
        normal_states = {
            item["name"] for item in load_and_validate(Path(".github/label.yaml"))
            if item["name"].startswith("state:") and item["name"] != FAILED_STATE
        }
        endpoint = f"repos/{repo}/issues/{args.issue_number}"
        issue = gh_json([endpoint])
        state, reason = eligible(issue, normal_states)
        if state is None:
            print(f"Skip: {reason}")
            return 0

        labels, updated_at = issue_snapshot(issue)
        comments = read_comments(endpoint)
        request = {
            "protocol_version": "1", "request_id": str(uuid.uuid4()), "repository": repo,
            "issue": {
                "number": args.issue_number, "title": issue.get("title", ""), "body": issue.get("body") or "",
                "labels": labels, "state": state, "updated_at": updated_at, "comments": comments,
            },
            "reviewer": {"name": policy["reviewer"]["name"], "model": policy["reviewer"]["model"]},
            "agents": policy["agents"],
        }
        decision = review(policy, request)

        # Re-read all review inputs; never apply a decision to a changed Issue.
        current = gh_json([endpoint])
        current_state, reason = eligible(current, normal_states)
        current_labels, current_updated_at = issue_snapshot(current)
        current_comments = read_comments(endpoint)
        if (current_state != state or current_updated_at != updated_at
                or sorted(current_labels) != sorted(labels) or current_comments != comments):
            print("Skip: Issue changed while review was in progress")
            return 0
        if current_state is None:
            print(f"Skip: {reason}")
            return 0

        action = f"action:{decision}"
        gh_json([f"{endpoint}/labels", "--method", "POST", "-f", f"labels[]={action}"])
        print(f"Assigned {action} to issue #{args.issue_number} at {state}")
        return 0
    except subprocess.TimeoutExpired:
        print("Error: TypeSafe review timed out; no action was assigned", file=sys.stderr)
    except subprocess.CalledProcessError as exc:
        print(f"Error: subprocess failed (exit {exc.returncode}); no fallback action assigned", file=sys.stderr)
    except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError, ValidationError, yaml.YAMLError):
        # Do not echo Issue content, untrusted API responses, or credentials to the job log.
        print("Error: invalid configuration, Issue data, or reviewer response; no fallback action assigned", file=sys.stderr)
        return 1
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
