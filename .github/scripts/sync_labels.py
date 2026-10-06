#!/usr/bin/env python3
"""Validate and synchronize the labels declared in .github/label.yaml."""

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

import yaml


NAME_RE = re.compile(r"^(?:state:|action:)(.+)$")
COLOR_RE = re.compile(r"^[0-9a-fA-F]{6}$")
ALLOWED_FIELDS = {"name", "color", "description"}
FAILED_STATE = "state:agent-failed"


class ValidationError(ValueError):
    pass


def load_and_validate(path: Path) -> list[dict[str, str]]:
    try:
        with path.open(encoding="utf-8") as stream:
            labels = yaml.safe_load(stream)
    except OSError as exc:
        raise ValidationError(f"Cannot read label file {path}: {exc}") from exc
    except yaml.YAMLError as exc:
        raise ValidationError(f"Invalid YAML: {exc}") from exc

    if not isinstance(labels, list) or not labels:
        raise ValidationError("Label file must contain a nonempty list")

    seen: set[str] = set()
    for index, item in enumerate(labels, start=1):
        context = f"Label {index}"
        if not isinstance(item, dict):
            raise ValidationError(f"{context} must be a mapping")
        unknown = set(item) - ALLOWED_FIELDS
        missing = ALLOWED_FIELDS - set(item)
        if unknown or missing:
            raise ValidationError(f"{context} fields mismatch (missing={sorted(missing)}, unknown={sorted(unknown)})")
        name, color, description = item["name"], item["color"], item["description"]
        if not isinstance(name, str) or not name or name != name.strip():
            raise ValidationError(f"{context} name must be a nonempty trimmed string")
        match = NAME_RE.fullmatch(name)
        if not match or not match.group(1).strip():
            raise ValidationError(f"{context} name must start with state: or action:")
        if name in seen:
            raise ValidationError(f"Duplicate label name: {name}")
        seen.add(name)
        if not isinstance(color, str) or not COLOR_RE.fullmatch(color):
            raise ValidationError(f"{context} color must be a six-digit hexadecimal value")
        if not isinstance(description, str) or len(description) > 100:
            raise ValidationError(f"{context} description must be at most 100 characters")
    return labels


def main() -> int:
    parser = argparse.ArgumentParser(description="Sync declared GitHub issue labels")
    parser.add_argument("--file", type=Path, default=Path(".github/label.yaml"))
    parser.add_argument("--repo", default=os.environ.get("GH_REPO") or os.environ.get("GITHUB_REPOSITORY"))
    parser.add_argument("--dry-run", action="store_true", help="Validate and print commands without calling GitHub")
    args = parser.parse_args()

    try:
        labels = load_and_validate(args.file)
        if not args.repo or not re.fullmatch(r"[^/\s]+/[^/\s]+", args.repo):
            raise ValidationError("Repository must be specified as owner/repo")
        for label in labels:
            command = [
                "gh", "label", "create", label["name"], "--repo", args.repo,
                "--color", label["color"], "--description", label["description"], "--force",
            ]
            if args.dry_run:
                print("DRY RUN:", " ".join(repr(part) for part in command))
            else:
                subprocess.run(command, check=True)
                print(f"Synced label: {label['name']}")
    except ValidationError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2
    except FileNotFoundError as exc:
        print(f"Error: GitHub CLI gh not found: {exc}", file=sys.stderr)
        return 1
    except subprocess.CalledProcessError as exc:
        print(f"Error: gh failed with exit code {exc.returncode}", file=sys.stderr)
        return exc.returncode or 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
