#!/usr/bin/env python3
"""Validate a critical-work delivery receipt."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


SHA256 = re.compile(r"^[0-9a-f]{64}$")
SUPPORTED_SCHEMAS = {"delivery-coordination-v1", "delivery-coordination-v2"}
STATE_ORDER = {"proposed": 0, "frozen": 1, "reviewed": 2, "live": 3, "complete": 4}
WORK_CLASSES = {
    "research",
    "implementation",
    "collection",
    "publication",
    "product",
    "operations",
}


EXAMPLE: dict[str, Any] = {
    "schema": "delivery-coordination-v2",
    "work_items": ["TASK-123"],
    "work_class": "product",
    "state": "complete",
    "user_outcome": "Users can reach the new result and see its truthful status.",
    "definition_of_done": [
        "Every declared item is represented on the supported surface.",
        "Incomplete states remain explicit.",
        "An independent reviewer matches the live hashes.",
    ],
    "roles": {
        "coordinator": "@coordinator",
        "editor": "@editor",
        "reviewer": "@reviewer",
        "release_executor": "@coordinator",
    },
    "source": {
        "baseline_revision": "0123456789abcdef",
        "source_context": "frozen production input bundle",
        "input_hashes": {"inputs.json": "a" * 64},
    },
    "change": {
        "revision_id": "fedcba9876543210",
        "patch_sha256": "b" * 64,
        "paths": ["src/feature.py", "tests/test_feature.py"],
        "workspace_clean": True,
    },
    "invariants": {
        "production_shaped": True,
        "identity_sensitive": False,
        "canonical_identity": "",
        "identity_consumers": [],
        "completion_dimensions": ["processing", "publication", "delivery"],
        "terminal_requires_observed_work": True,
        "preserves_prior_evidence": True,
        "touches_persistence_contract": True,
    },
    "validation": {
        "production_fixture": "byte-identical clone of the frozen input bundle",
        "target_count": 12,
        "observed_count": 12,
        "tests": [{"name": "project test gate", "status": "pass"}],
        "negative_states_checked": ["pending", "unknown", "blocked"],
        "consumer_surfaces": ["primary UI", "export"],
        "legacy_versions_checked": ["previous-version-id"],
    },
    "review": {"exact_revision_reviewed": True, "verdict": "GO"},
    "release": {
        "plan_or_gate_pass": True,
        "approval_identities": ["@reviewer"],
        "additional_approval_reason": "",
        "delegated_release_reason": "",
        "current_verified": True,
        "supported_surfaces_verified": True,
        "previous_or_rollback_verified": True,
        "rollback_not_applicable_reason": "",
        "rollback_forward_verified": True,
        "independent_live_reviewer": "@reviewer",
        "separate_live_reviewer_reason": "",
    },
    "tracker": {
        "body_preserved": True,
        "justification_comment": True,
        "status_matches_reality": True,
        "not_applicable_reason": "",
    },
    "open_work": [],
}


def require(condition: bool, message: str, errors: list[str]) -> None:
    if not condition:
        errors.append(message)


def nonempty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def string_list(value: Any, minimum: int = 1) -> bool:
    return (
        isinstance(value, list)
        and len(value) >= minimum
        and all(nonempty_string(item) for item in value)
        and len(value) == len(set(value))
    )


def validate(receipt: Any) -> list[str]:
    errors: list[str] = []
    require(isinstance(receipt, dict), "receipt must be a JSON object", errors)
    if not isinstance(receipt, dict):
        return errors

    schema = receipt.get("schema")
    require(schema in SUPPORTED_SCHEMAS, "unsupported schema", errors)
    minimal_roles = schema == "delivery-coordination-v2"
    require(
        string_list(receipt.get("work_items")),
        "work_items must be unique nonempty strings",
        errors,
    )
    require(receipt.get("work_class") in WORK_CLASSES, "invalid work_class", errors)
    state = receipt.get("state")
    require(state in STATE_ORDER, "invalid state", errors)
    level = STATE_ORDER.get(state, -1)
    require(nonempty_string(receipt.get("user_outcome")), "user_outcome is required", errors)
    require(
        string_list(receipt.get("definition_of_done"), 3),
        "definition_of_done needs 3 unique items",
        errors,
    )

    roles = receipt.get("roles")
    require(isinstance(roles, dict), "roles must be an object", errors)
    if isinstance(roles, dict):
        require(nonempty_string(roles.get("coordinator")), "roles.coordinator is required", errors)
        editor = roles.get("editor")
        reviewer = roles.get("reviewer")
        if receipt.get("work_class") != "research":
            require(nonempty_string(editor), "roles.editor is required", errors)
        if level >= STATE_ORDER["reviewed"]:
            require(nonempty_string(reviewer), "roles.reviewer is required", errors)
            require(editor != reviewer, "editor and reviewer must be distinct", errors)

    source = receipt.get("source")
    require(isinstance(source, dict), "source must be an object", errors)
    if isinstance(source, dict):
        require(
            nonempty_string(source.get("baseline_revision")),
            "source.baseline_revision is required",
            errors,
        )
        require(
            nonempty_string(source.get("source_context")),
            "source.source_context is required",
            errors,
        )
        hashes = source.get("input_hashes")
        require(
            isinstance(hashes, dict) and bool(hashes),
            "source.input_hashes must be nonempty",
            errors,
        )
        if isinstance(hashes, dict):
            require(
                all(
                    nonempty_string(key) and bool(SHA256.fullmatch(str(value)))
                    for key, value in hashes.items()
                ),
                "every input hash must be named and contain 64 lowercase hex",
                errors,
            )

    invariants: Any = None
    if level >= STATE_ORDER["frozen"]:
        change = receipt.get("change")
        require(isinstance(change, dict), "change must be an object at frozen state", errors)
        if isinstance(change, dict):
            require(nonempty_string(change.get("revision_id")), "change.revision_id is required", errors)
            require(
                bool(SHA256.fullmatch(str(change.get("patch_sha256", "")))),
                "change.patch_sha256 must be 64 lowercase hex",
                errors,
            )
            require(string_list(change.get("paths")), "change.paths must be unique and nonempty", errors)
            require(change.get("workspace_clean") is True, "frozen workspace must be clean", errors)

        invariants = receipt.get("invariants")
        require(isinstance(invariants, dict), "invariants must be an object", errors)
        if isinstance(invariants, dict):
            require(invariants.get("production_shaped") is True, "production_shaped must be true", errors)
            require(
                invariants.get("terminal_requires_observed_work") is True,
                "terminal states must require observed work",
                errors,
            )
            require(
                invariants.get("preserves_prior_evidence") is True,
                "prior evidence must be preserved",
                errors,
            )
            require(
                string_list(invariants.get("completion_dimensions")),
                "completion_dimensions must be explicit",
                errors,
            )
            if invariants.get("identity_sensitive") is True:
                require(
                    nonempty_string(invariants.get("canonical_identity")),
                    "canonical_identity is required",
                    errors,
                )
                require(
                    string_list(invariants.get("identity_consumers"), 2),
                    "identity_consumers need at least 2 paths",
                    errors,
                )

        validation = receipt.get("validation")
        require(isinstance(validation, dict), "validation must be an object", errors)
        if isinstance(validation, dict):
            require(
                nonempty_string(validation.get("production_fixture")),
                "production_fixture is required",
                errors,
            )
            target = validation.get("target_count")
            observed = validation.get("observed_count")
            require(isinstance(target, int) and target > 0, "target_count must be positive", errors)
            require(observed == target, "observed_count must equal target_count", errors)
            tests = validation.get("tests")
            require(isinstance(tests, list) and bool(tests), "validation.tests must be nonempty", errors)
            if isinstance(tests, list):
                require(
                    all(
                        isinstance(test, dict)
                        and nonempty_string(test.get("name"))
                        and test.get("status") == "pass"
                        for test in tests
                    ),
                    "every validation test must be named and pass",
                    errors,
                )
            negative = validation.get("negative_states_checked")
            require(
                string_list(negative)
                and {"pending", "unknown", "blocked"}.issubset(set(negative)),
                "negative_states_checked must include pending, unknown, and blocked",
                errors,
            )
            require(
                string_list(validation.get("consumer_surfaces")),
                "consumer_surfaces must be explicit",
                errors,
            )
            if isinstance(invariants, dict) and invariants.get("touches_persistence_contract") is True:
                require(
                    string_list(validation.get("legacy_versions_checked")),
                    "legacy version checks are required",
                    errors,
                )

    if level >= STATE_ORDER["reviewed"]:
        review = receipt.get("review")
        require(isinstance(review, dict), "review must be an object", errors)
        if isinstance(review, dict):
            require(review.get("exact_revision_reviewed") is True, "review must bind the exact revision", errors)
            require(review.get("verdict") == "GO", "review verdict must be GO", errors)

    if level >= STATE_ORDER["live"]:
        release = receipt.get("release")
        require(isinstance(release, dict), "release must be an object", errors)
        if isinstance(release, dict):
            for key in ("plan_or_gate_pass", "current_verified", "supported_surfaces_verified"):
                require(release.get(key) is True, f"release.{key} must be true", errors)
            approvals = release.get("approval_identities")
            roles = receipt.get("roles") if isinstance(receipt.get("roles"), dict) else {}
            reviewer = roles.get("reviewer")
            if minimal_roles:
                require(
                    string_list(approvals),
                    "at least one independent approval identity is required",
                    errors,
                )
                if isinstance(approvals, list):
                    require(
                        reviewer in approvals,
                        "approval_identities must include the controlling reviewer",
                        errors,
                    )
                    if len(approvals) > 1:
                        require(
                            nonempty_string(release.get("additional_approval_reason")),
                            "additional approvals require an explicit policy or user reason",
                            errors,
                        )
            else:
                require(
                    string_list(approvals, 2),
                    "v1 receipts require two distinct approval identities",
                    errors,
                )
            executor = roles.get("release_executor")
            if minimal_roles:
                require(
                    nonempty_string(executor),
                    "roles.release_executor is required at live state",
                    errors,
                )
                require(
                    executor != roles.get("editor"),
                    "editor and release executor must be distinct",
                    errors,
                )
                if nonempty_string(executor) and executor != roles.get("coordinator"):
                    require(
                        nonempty_string(release.get("delegated_release_reason")),
                        "a delegated release executor requires an explicit access, capability, or policy reason",
                        errors,
                    )
            live_reviewer = release.get("independent_live_reviewer")
            require(
                nonempty_string(live_reviewer),
                "independent_live_reviewer is required",
                errors,
            )
            if minimal_roles and nonempty_string(live_reviewer) and live_reviewer != reviewer:
                require(
                    nonempty_string(release.get("separate_live_reviewer_reason")),
                    "a separate live reviewer requires an explicit capability or policy reason",
                    errors,
                )
            rollback_ok = release.get("previous_or_rollback_verified") is True
            rollback_na = nonempty_string(release.get("rollback_not_applicable_reason"))
            require(
                rollback_ok or rollback_na,
                "verify previous/rollback or explain why it is not applicable",
                errors,
            )

    if level >= STATE_ORDER["complete"]:
        release = receipt.get("release", {})
        rollback_complete = isinstance(release, dict) and (
            release.get("rollback_forward_verified") is True
            or nonempty_string(release.get("rollback_not_applicable_reason"))
        )
        require(rollback_complete, "rollback/forward proof or a not-applicable reason is required", errors)
        tracker = receipt.get("tracker")
        require(isinstance(tracker, dict), "tracker must be an object", errors)
        if isinstance(tracker, dict):
            tracker_na = nonempty_string(tracker.get("not_applicable_reason"))
            if not tracker_na:
                for key in ("body_preserved", "justification_comment", "status_matches_reality"):
                    require(tracker.get(key) is True, f"tracker.{key} must be true", errors)
        require(receipt.get("open_work") == [], "open_work must be empty at complete", errors)

    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("receipt", nargs="?", type=Path)
    parser.add_argument("--print-example", action="store_true")
    args = parser.parse_args()

    if args.print_example:
        print(json.dumps(EXAMPLE, indent=2, sort_keys=True))
        return 0
    if args.receipt is None:
        parser.error("receipt is required unless --print-example is used")

    try:
        value = json.loads(args.receipt.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        print(f"REFUSED: cannot read receipt: {error}", file=sys.stderr)
        return 2

    errors = validate(value)
    if errors:
        for error in errors:
            print(f"REFUSED: {error}", file=sys.stderr)
        return 2

    print("PASS: delivery receipt satisfies its declared state")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
