#!/usr/bin/env python3
"""Send the internal review request to TypeSafe Jev and validate its answer."""

import json
import math
import os
import socket
import sys
from pathlib import Path
import urllib.error
import urllib.request

import yaml


ENDPOINT = "https://api.typesafe.ai/v1/systemone"
ERRORS = {
    2: "invalid internal review request", 3: "TYPESAFE_API_KEY is missing",
    4: "TypeSafe authentication failed (HTTP 401/403)", 5: "TypeSafe rate limit reached (HTTP 429)",
    6: "TypeSafe HTTP request failed", 7: "TypeSafe network request failed",
    8: "TypeSafe request timed out", 9: "invalid TypeSafe response",
}
STAGES = {
    "state:needs-triage": "确认需求与验收目标",
    "state:assess-plan": "提出实现方案与验证计划",
    "state:coding": "修改代码并验证",
    "state:code-review": "检查符合性、缺陷与风险",
    "state:wait-auto-merge": "跟进检查和关联 PR 合并",
}


def exact_fields(value, expected):
    if not isinstance(value, dict) or set(value) != set(expected):
        raise ValueError("unexpected fields")


def nonempty_string(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("expected nonempty string")


def parse_json(value):
    def unique_pairs(items):
        result = {}
        for key, item in items:
            if key in result:
                raise ValueError("duplicate field")
            result[key] = item
        return result
    return json.loads(value, object_pairs_hook=unique_pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite number")))


def validate_request(request):
    exact_fields(request, {"protocol_version", "request_id", "repository", "issue", "reviewer", "agents"})
    if request["protocol_version"] != "1":
        raise ValueError("unsupported protocol")
    nonempty_string(request["request_id"])
    nonempty_string(request["repository"])
    issue = request["issue"]
    exact_fields(issue, {"number", "title", "body", "comments", "labels", "state", "updated_at"})
    if type(issue["number"]) is not int or issue["number"] <= 0:
        raise ValueError("invalid issue number")
    if not isinstance(issue["title"], str) or not isinstance(issue["body"], str):
        raise ValueError("invalid issue text")
    nonempty_string(issue["updated_at"])
    if not isinstance(issue["comments"], list):
        raise ValueError("invalid comments")
    seen = set()
    for comment in issue["comments"]:
        exact_fields(comment, {"id", "author", "body", "created_at", "updated_at"})
        comment_id = comment["id"]
        if type(comment_id) is not int or comment_id <= 0 or comment_id in seen:
            raise ValueError("invalid comment id")
        seen.add(comment_id)
        if comment["author"] is not None:
            nonempty_string(comment["author"])
        if not isinstance(comment["body"], str):
            raise ValueError("invalid comment body")
        nonempty_string(comment["created_at"])
        nonempty_string(comment["updated_at"])
    if issue["state"] not in STAGES or not isinstance(issue["state"], str):
        raise ValueError("invalid state")
    if not isinstance(issue["labels"], list) or any(not isinstance(label, str) for label in issue["labels"]):
        raise ValueError("invalid labels")
    state_labels = [label for label in issue["labels"] if label.startswith("state:")]
    if state_labels != [issue["state"]] or any(label.startswith("action:") for label in issue["labels"]):
        raise ValueError("ineligible labels")
    exact_fields(request["reviewer"], {"name", "model"})
    if request["reviewer"]["name"] != "TypeSafe":
        raise ValueError("invalid reviewer")
    nonempty_string(request["reviewer"]["model"])
    if not isinstance(request["agents"], list) or any(not isinstance(agent, dict) for agent in request["agents"]):
        raise ValueError("invalid agents")
    json.dumps(request, allow_nan=False)


def load_prompts():
    path = Path(__file__).resolve().parents[1] / "prompts" / "state-review.yaml"
    with path.open(encoding="utf-8") as stream:
        prompts = yaml.safe_load(stream)
    exact_fields(prompts, {"instructions", "criteria", "stages"})
    nonempty_string(prompts["instructions"])
    exact_fields(prompts["criteria"], {"current_model", "stronger_model"})
    exact_fields(prompts["stages"], STAGES)
    for value in [*prompts["criteria"].values(), *prompts["stages"].values()]:
        nonempty_string(value)
    return prompts


def build_payload(request):
    prompts = load_prompts()
    stage = request["issue"]["state"]
    return {
        "model": request["reviewer"]["model"],
        "state": {
            "repository": request["repository"], "issue": request["issue"],
            "stage_task": STAGES[stage], "agents": request["agents"],
        },
        "questions": {"assignment": {
            "type": "choice", "instructions": prompts["instructions"] + "\n当前阶段：" + prompts["stages"][stage],
            "criteria": prompts["criteria"],
        }},
    }


def probability(value):
    if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 1:
        raise ValueError("invalid probability")


def translate(request, response):
    json.dumps(response, allow_nan=False)
    exact_fields(response, {"model", "answers", "usage"})
    nonempty_string(response["model"])
    if not isinstance(response["usage"], dict):
        raise ValueError("invalid usage")
    exact_fields(response["answers"], {"assignment"})
    answer = response["answers"]["assignment"]
    exact_fields(answer, {"type", "choice", "confidence", "probabilities"})
    mapping = {"current_model": "agent", "stronger_model": "human"}
    if answer["type"] != "choice" or answer["choice"] not in mapping:
        raise ValueError("invalid choice")
    probability(answer["confidence"])
    exact_fields(answer["probabilities"], set(mapping))
    for value in answer["probabilities"].values():
        probability(value)
    if not math.isclose(sum(answer["probabilities"].values()), 1, abs_tol=1e-6):
        raise ValueError("probabilities must sum to one")
    decision = mapping[answer["choice"]]
    reason = f"TypeSafe selected {answer['choice']} and mapped it to action:{decision}; confidence {answer['confidence']:.3f}."
    return {
        "protocol_version": "1", "request_id": request["request_id"],
        "issue_number": request["issue"]["number"], "expected_state": request["issue"]["state"],
        "decision": decision, "reason": reason,
    }


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def fail(code):
    print(f"Error: {ERRORS[code]}", file=sys.stderr)
    return code


def main():
    try:
        request = parse_json(sys.stdin.read())
        validate_request(request)
        outgoing_payload = build_payload(request)
    except (OSError, ValueError, TypeError, KeyError, yaml.YAMLError):
        return fail(2)
    key = os.environ.get("TYPESAFE_API_KEY", "").strip()
    if not key:
        return fail(3)
    try:
        outgoing = urllib.request.Request(
            ENDPOINT,
            data=json.dumps(outgoing_payload, ensure_ascii=False, allow_nan=False).encode("utf-8"),
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json", "Accept": "application/json"},
            method="POST",
        )
        with urllib.request.build_opener(NoRedirect()).open(outgoing, timeout=60) as result:
            raw = result.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            return fail(9)
    except urllib.error.HTTPError as exc:
        return fail(4 if exc.code in (401, 403) else 5 if exc.code == 429 else 6)
    except (TimeoutError, socket.timeout):
        return fail(8)
    except urllib.error.URLError as exc:
        return fail(8 if isinstance(exc.reason, (TimeoutError, socket.timeout)) else 7)
    except (OSError, ValueError):
        return fail(7)
    try:
        response = translate(request, parse_json(raw))
    except (ValueError, TypeError, KeyError, UnicodeError):
        return fail(9)
    print(json.dumps(response, ensure_ascii=False, allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
