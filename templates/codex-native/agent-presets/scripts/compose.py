"""Render a Codex role from an ordered template of local traits."""

import argparse
import json
from pathlib import Path
import re
import sys
import tomllib


SKILL_DIR = Path(__file__).resolve().parent.parent
DISABLABLE_FEATURES = {"apps", "memories", "plugins", "request_permissions_tool", "shell_tool"}
TRAIT_KINDS = {
    "task-intake",
    "clarification",
    "risk-assessment",
    "research",
    "planning",
    "implementation",
    "verification",
    "independent-review",
}


def load_toml(path):
    with path.open("rb") as stream:
        return tomllib.load(stream)


def feature_set(values):
    if not isinstance(values, list) or any(value not in DISABLABLE_FEATURES for value in values):
        raise ValueError("disabled_features must list supported feature names")
    return set(values)


def compose(preset_name):
    templates = load_toml(SKILL_DIR / "templates.toml")
    if preset_name not in templates["presets"]:
        raise ValueError(f"Unknown preset: {preset_name}")
    preset = templates["presets"][preset_name]
    trait_names = preset["traits"]
    if not isinstance(trait_names, list) or not trait_names:
        raise ValueError("A preset must select at least one trait")
    if any(not isinstance(name, str) or not re.fullmatch(r"[A-Z][A-Za-z0-9]*", name) for name in trait_names):
        raise ValueError("Invalid trait name")
    if len(set(trait_names)) != len(trait_names):
        raise ValueError("Each trait may occur only once in a preset")

    instructions = [
        "Use only the tools, operations, and paths explicitly assigned for this task.",
        "Follow the listed stages in order. Ask the primary agent to handle missing inputs, new authorization, or further delegation.",
    ]
    features = feature_set(templates.get("disabled_features", []))
    kinds = set()
    for trait_name in trait_names:
        trait = load_toml(SKILL_DIR / "traits" / f"{trait_name}.toml")
        kind = trait["kind"]
        if kind not in TRAIT_KINDS:
            raise ValueError(f"Unsupported trait kind: {kind}")
        kinds.add(kind)
        features.update(feature_set(trait.get("disabled_features", [])))
        instructions.append(f"\n## {trait_name}\n\n{trait['instructions'].strip()}")

    if {"implementation", "independent-review"} <= kinds:
        raise ValueError("Use separate assignments for implementation and independent review")
    return preset["description"], "\n".join(instructions), features


def render(name, description, instructions, features):
    text = instructions.replace("\\", "\\\\").replace('"', '\\"')
    feature_lines = "".join(f"{key} = false\n" for key in sorted(features))
    return (
        "# Generated from agent-presets/templates.toml and its selected traits.\n"
        f"name = {json.dumps(name)}\n"
        f"description = {json.dumps(description, ensure_ascii=False)}\n"
        f'developer_instructions = """\n{text}\n"""\n\n'
        f"[features]\n{feature_lines}"
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("preset")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--instructions", action="store_true", help="Print the composed instructions only.")
    mode.add_argument("--check", type=Path, help="Check an existing registered TOML against the template.")
    args = parser.parse_args()

    try:
        description, instructions, features = compose(args.preset)
        if args.instructions:
            print(instructions)
        else:
            content = render(args.preset, description, instructions, features)
            if args.check is not None:
                if args.check.read_text(encoding="utf-8-sig") != content:
                    raise ValueError(f"Registered preset differs from its template: {args.preset}")
            else:
                sys.stdout.write(content)
    except (KeyError, TypeError, ValueError, OSError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
