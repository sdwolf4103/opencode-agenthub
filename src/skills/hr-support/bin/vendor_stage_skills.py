#!/usr/bin/env python3

import json
import shutil
import sys
from pathlib import Path


HR_HOME = Path(__file__).resolve().parent.parent
WORKERS_ROOT = HR_HOME / "inventory" / "workers"


def resolve_import_root(stage_arg: str) -> Path:
    stage_path = Path(stage_arg).resolve()
    if (stage_path / "bundles").exists() and (stage_path / "profiles").exists():
        return stage_path
    import_root = stage_path / "agenthub-home"
    if (import_root / "bundles").exists() and (import_root / "profiles").exists():
        return import_root
    raise SystemExit(f"No importable Agent Hub root found under: {stage_path}")


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def locate_skill_card(skill_name: str) -> dict:
    for worker_file in sorted(WORKERS_ROOT.glob("*.json")):
        card = read_json(worker_file)
        if card.get("asset_kind") != "skill":
            continue
        if skill_name in {
            card.get("candidate_slug"),
            card.get("name"),
            worker_file.stem,
        }:
            return card
    raise SystemExit(f"Missing worker card for skill: {skill_name}")


def resolve_source_dir(card: dict) -> Path:
    cached_repo = Path(card.get("artifacts", {}).get("cached_repo", ""))
    if not cached_repo:
        raise SystemExit(
            f"Missing cached_repo artifact for skill: {card.get('name', 'unknown')}"
        )
    repo_root = cached_repo if cached_repo.is_absolute() else HR_HOME / cached_repo
    source_path = card.get("source_path") or card.get("artifacts", {}).get(
        "source_file"
    )
    if not source_path:
        raise SystemExit(
            f"Missing source_path for skill: {card.get('name', 'unknown')}"
        )
    source_file = repo_root / source_path
    if source_file.is_dir():
        return source_file
    if source_file.exists():
        return source_file.parent
    raise SystemExit(
        f"Missing source directory for skill {card.get('name', 'unknown')}: {source_file}"
    )


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit(
            "Usage: vendor_stage_skills.py <stage-package-root|agenthub-home-root>"
        )

    import_root = resolve_import_root(sys.argv[1])
    skills_root = import_root / "skills"
    skills_root.mkdir(parents=True, exist_ok=True)

    required_skills: set[str] = set()
    for bundle_file in sorted((import_root / "bundles").glob("*.json")):
        bundle = read_json(bundle_file)
        for skill_name in bundle.get("skills", []):
            required_skills.add(skill_name)

    vendored: list[str] = []
    skipped: list[str] = []
    for skill_name in sorted(required_skills):
        target_dir = skills_root / skill_name
        if target_dir.exists():
            skipped.append(skill_name)
            continue

        card = locate_skill_card(skill_name)
        shutil.copytree(resolve_source_dir(card), target_dir, dirs_exist_ok=True)
        vendored.append(skill_name)

    print("Vendored skills:")
    for skill in vendored:
        print(f"- {skill}")
    if skipped:
        print("Already present:")
        for skill in skipped:
            print(f"- {skill}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
