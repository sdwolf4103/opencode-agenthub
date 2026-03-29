#!/usr/bin/env python3

import fnmatch
import json
import re
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


HR_HOME = Path(__file__).resolve().parent.parent
CONFIG_PATH = HR_HOME / "hr-config.json"
INVENTORY_ROOT = HR_HOME / "inventory"
WORKERS_ROOT = INVENTORY_ROOT / "workers"
MODELS_ROOT = INVENTORY_ROOT / "models"
CACHE_ROOT = HR_HOME / "sources" / "github"
STATUS_PATH = HR_HOME / "source-status.json"
MODEL_CATALOG_PATH = MODELS_ROOT / "catalog.json"
MODEL_IDS_PATH = MODELS_ROOT / "valid-model-ids.txt"


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def slugify(value: str) -> str:
    value = value.lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-")


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return path.read_text(encoding="utf-8", errors="ignore")


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, indent=2, ensure_ascii=True) + "\n", encoding="utf-8"
    )


def run(cmd: list[str], cwd: Path | None = None) -> str:
    result = subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"command failed: {' '.join(cmd)}\n{result.stderr.strip()}")
    return result.stdout.strip()


def parse_frontmatter(text: str) -> dict[str, str]:
    lines = text.splitlines()
    if len(lines) < 3 or lines[0].strip() != "---":
        return {}

    data: dict[str, str] = {}
    i = 1
    while i < len(lines):
        line = lines[i]
        if line.strip() == "---":
            break
        if ":" not in line:
            i += 1
            continue
        key, value = line.split(":", 1)
        key = key.strip()
        value = value.strip().strip('"')
        if value in {">", "|"}:
            block: list[str] = []
            i += 1
            while i < len(lines):
                nested = lines[i]
                if nested.strip() == "---":
                    i -= 1
                    break
                if nested and not nested.startswith((" ", "\t")) and ":" in nested:
                    i -= 1
                    break
                if nested.strip():
                    block.append(nested.strip())
                i += 1
            value = " ".join(block).strip()
        data[key] = value
        i += 1
    return data


def infer_name(path: Path, text: str) -> str:
    frontmatter = parse_frontmatter(text)
    name = frontmatter.get("name", "").strip()
    if name:
        return name

    for line in text.splitlines()[:40]:
        stripped = line.strip()
        if stripped.startswith("# Agent:"):
            return stripped.split(":", 1)[1].strip()
        if stripped.startswith("# "):
            return stripped[2:].strip()
        if stripped.startswith("name:"):
            return stripped.split(":", 1)[1].strip().strip('"')
    return path.stem


def infer_summary(text: str, fallback: str) -> str:
    frontmatter = parse_frontmatter(text)
    description = frontmatter.get("description", "").strip()
    if description and description not in {">", "|"}:
        return description[:280]

    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith(
            (
                "#",
                "---",
                "name:",
                "description:",
                "audience:",
                "license:",
                "compatibility:",
                "metadata:",
            )
        ):
            continue
        return stripped[:280]
    return fallback


def match_any(path: str, patterns: list[str]) -> bool:
    return any(fnmatch.fnmatch(path, pattern) for pattern in patterns)


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        raise SystemExit(f"Missing HR config: {CONFIG_PATH}")
    return read_json(CONFIG_PATH)


def github_sources(config: dict) -> list[dict]:
    raw_sources = []
    top_sources = config.get("sources", {})
    if isinstance(top_sources, list):
        raw_sources.extend(top_sources)
    elif isinstance(top_sources, dict):
        raw_sources.extend(top_sources.get("github", []))

    if isinstance(config.get("github"), list):
        raw_sources.extend(config["github"])

    settings = (
        config.get("settings", {}) if isinstance(config.get("settings"), dict) else {}
    )
    sync_depth = settings.get("sync_depth", 1)
    sources: list[dict] = []
    for entry in raw_sources:
        if isinstance(entry, str):
            repo = entry
            source = {
                "repo": repo,
                "branch": "main",
                "include": ["**/*"],
                "exclude": [
                    ".git/**",
                    "node_modules/**",
                    "dist/**",
                    "build/**",
                    "coverage/**",
                ],
                "source_id": slugify(repo),
                "sync_depth": sync_depth,
            }
        elif isinstance(entry, dict) and isinstance(entry.get("repo"), str):
            repo = entry["repo"]
            source = {
                "repo": repo,
                "branch": entry.get("branch", "main"),
                "include": entry.get("include", ["**/*"]),
                "exclude": entry.get(
                    "exclude",
                    [
                        ".git/**",
                        "node_modules/**",
                        "dist/**",
                        "build/**",
                        "coverage/**",
                    ],
                ),
                "source_id": entry.get("source_id", slugify(repo)),
                "sync_depth": entry.get("sync_depth", sync_depth),
            }
        else:
            continue
        sources.append(source)
    return sources


def model_catalog_sources(config: dict) -> list[dict]:
    raw_sources = []
    top_sources = config.get("sources", {})
    if isinstance(top_sources, dict):
        raw_sources.extend(top_sources.get("models", []))

    if isinstance(config.get("models"), list):
        raw_sources.extend(config["models"])

    if not raw_sources:
        raw_sources.append(
            {
                "source_id": "models-dev",
                "url": "https://models.dev/api.json",
                "format": "models.dev",
            }
        )

    sources: list[dict] = []
    for entry in raw_sources:
        if isinstance(entry, str):
            source = {
                "source_id": slugify(entry),
                "url": entry,
                "format": "models.dev",
            }
        elif isinstance(entry, dict) and isinstance(entry.get("url"), str):
            source = {
                "source_id": entry.get("source_id", slugify(entry["url"])),
                "url": entry["url"],
                "format": entry.get("format", "models.dev"),
            }
        else:
            continue
        sources.append(source)
    return sources


def git_cache_dir(repo_slug: str) -> Path:
    owner, repo = repo_slug.split("/", 1)
    return CACHE_ROOT / f"{owner}--{repo}"


def ensure_repo(source: dict) -> tuple[Path, str]:
    repo_slug = source["repo"]
    branch = source.get("branch", "main")
    depth = str(source.get("sync_depth", 1))
    repo_dir = git_cache_dir(repo_slug)
    remote_url = f"https://github.com/{repo_slug}.git"
    repo_dir.parent.mkdir(parents=True, exist_ok=True)

    if not repo_dir.exists():
        run(
            [
                "git",
                "clone",
                "--depth",
                depth,
                "--branch",
                branch,
                remote_url,
                str(repo_dir),
            ]
        )
    else:
        run(["git", "remote", "set-url", "origin", remote_url], cwd=repo_dir)
        run(["git", "fetch", "--depth", depth, "origin", branch], cwd=repo_dir)
        run(["git", "checkout", "-B", branch, f"origin/{branch}"], cwd=repo_dir)

    commit = run(["git", "rev-parse", "HEAD"], cwd=repo_dir)
    return repo_dir, commit


def should_keep_candidate(rel_path: str, text: str) -> bool:
    lower_rel = rel_path.lower()
    name = Path(lower_rel).name
    if Path(lower_rel).suffix not in {".md", ".json", ".toml"}:
        return False
    if name in {"skill.md", "skill.toml", "claude.md", "agents.md", "conductor.json"}:
        return True
    if any(part in lower_rel.split("/") for part in {"souls", "skills", "agents"}):
        return True
    lowered = text.lower()
    return (
        "# agent:" in lowered
        or "required attached skills" in lowered
        or lowered.startswith("---\nname:")
    )


def classify_asset(rel_path: str, text: str) -> tuple[str, str, str, str]:
    lower_rel = rel_path.lower()
    lower_text = text.lower()
    is_skill = (
        Path(lower_rel).name in {"skill.md", "skill.toml"} or "/skills/" in lower_rel
    )
    if is_skill:
        return ("skill", "not-applicable", "skill-attachment", "skill-only")
    if "required attached skills" in lower_text or "mixed soul+skill" in lower_text:
        return ("agent", "mixed-soul-skill", "subagent-preferred", "needs-adaptation")
    return ("agent", "pure-soul", "primary-capable", "needs-adaptation")


def fetch_json(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=30) as response:
        charset = response.headers.get_content_charset("utf-8")
        payload = response.read().decode(charset)
    data = json.loads(payload)
    if not isinstance(data, dict):
        raise RuntimeError(f"expected JSON object from {url}")
    return data


def build_model_catalog(source: dict, payload: dict) -> dict:
    providers: list[dict] = []
    model_entries: list[dict] = []
    model_ids: list[str] = []

    for provider_key, provider_data in sorted(payload.items()):
        if not isinstance(provider_data, dict):
            continue
        provider_id = provider_data.get("id")
        if not isinstance(provider_id, str) or not provider_id.strip():
            provider_id = str(provider_key)
        provider_name = (
            provider_data.get("name")
            if isinstance(provider_data.get("name"), str)
            else provider_id
        )
        models = provider_data.get("models")
        if not isinstance(models, dict):
            continue

        provider_model_count = 0
        for model_key, model_data in sorted(models.items()):
            if not isinstance(model_data, dict):
                continue
            model_id = model_data.get("id")
            if not isinstance(model_id, str) or not model_id.strip():
                model_id = str(model_key)
            normalized_id = f"{provider_id}/{model_id}"
            model_name = (
                model_data.get("name")
                if isinstance(model_data.get("name"), str)
                else model_id
            )
            model_entries.append(
                {
                    "provider": provider_id,
                    "provider_name": provider_name,
                    "model": model_id,
                    "model_name": model_name,
                    "id": normalized_id,
                }
            )
            model_ids.append(normalized_id)
            provider_model_count += 1

        providers.append(
            {
                "id": provider_id,
                "name": provider_name,
                "model_count": provider_model_count,
            }
        )

    unique_model_ids = sorted(set(model_ids))
    return {
        "schema_version": "1.0",
        "generated_at": now_iso(),
        "source": {
            "source_id": source["source_id"],
            "url": source["url"],
            "format": source.get("format", "models.dev"),
        },
        "provider_count": len(
            [provider for provider in providers if provider["model_count"] > 0]
        ),
        "model_count": len(unique_model_ids),
        "providers": [
            provider for provider in providers if provider["model_count"] > 0
        ],
        "models": model_entries,
    }


def sync_model_catalog(source: dict) -> tuple[int, int]:
    source_format = source.get("format", "models.dev")
    if source_format != "models.dev":
        raise RuntimeError(f"unsupported model catalog format: {source_format}")

    payload = fetch_json(source["url"])
    catalog = build_model_catalog(source, payload)
    model_ids = [entry["id"] for entry in catalog["models"]]

    MODELS_ROOT.mkdir(parents=True, exist_ok=True)
    write_json(MODEL_CATALOG_PATH, catalog)
    MODEL_IDS_PATH.write_text("\n".join(model_ids) + "\n", encoding="utf-8")
    return catalog["provider_count"], catalog["model_count"]


def scan_source(source: dict, repo_dir: Path, commit: str) -> tuple[int, int]:
    include = source.get("include", ["**/*"])
    exclude = source.get("exclude", [])
    repo_slug = source["repo"]
    source_id = source["source_id"]
    discovered = 0
    updated = 0

    for path in sorted(repo_dir.rglob("*")):
        if not path.is_file():
            continue
        rel_path = path.relative_to(repo_dir).as_posix()
        if not match_any(rel_path, include):
            continue
        if exclude and match_any(rel_path, exclude):
            continue

        text = read_text(path)
        if not should_keep_candidate(rel_path, text):
            continue

        discovered += 1
        candidate_slug = slugify(
            f"{source_id}-{Path(rel_path).with_suffix('').as_posix().replace('/', '-')}"
        )
        worker_path = WORKERS_ROOT / f"{candidate_slug}.json"
        existing = read_json(worker_path) if worker_path.exists() else {}
        name = infer_name(path, text)
        summary = infer_summary(text, f"Imported from {repo_slug}:{rel_path}")
        asset_kind, agent_class, deployment_role, compatibility = classify_asset(
            rel_path, text
        )

        card = {
            "schema_version": "1.1",
            "candidate_slug": candidate_slug,
            "worker_id": f"{source_id}:{rel_path}",
            "name": name,
            "summary": summary,
            "source_id": f"github:{repo_slug}",
            "source_path": rel_path,
            "source_commit": commit,
            "inventory_status": existing.get("inventory_status", "draft"),
            "asset_kind": asset_kind,
            "agent_class": agent_class,
            "deployment_role": deployment_role,
            "host_requirement": existing.get(
                "host_requirement",
                "requires-host-agent" if asset_kind == "skill" else "none",
            ),
            "self_contained": existing.get("self_contained", asset_kind != "skill"),
            "compatibility": existing.get("compatibility", compatibility),
            "risk_tier": existing.get("risk_tier", "unknown"),
            "testing_readiness": existing.get("testing_readiness", "unknown"),
            "description_clarity": existing.get(
                "description_clarity", "needs-clarification"
            ),
            "recommended_hosts": existing.get("recommended_hosts", []),
            "flags": existing.get("flags", []),
            "artifacts": {
                "cached_repo": str(repo_dir.relative_to(HR_HOME)),
                "source_file": rel_path,
                "review_notes": existing.get("artifacts", {}).get("review_notes"),
            },
        }
        write_json(worker_path, card)
        updated += 1

    return discovered, updated


def main() -> int:
    config = load_config()
    sources = github_sources(config)
    model_sources = model_catalog_sources(config)
    WORKERS_ROOT.mkdir(parents=True, exist_ok=True)
    MODELS_ROOT.mkdir(parents=True, exist_ok=True)

    status = {
        "schema_version": "1.1",
        "generated_at": now_iso(),
        "sources": {},
        "model_catalogs": {},
    }
    if STATUS_PATH.exists():
        try:
            status = read_json(STATUS_PATH)
            status.setdefault("schema_version", "1.1")
            status.setdefault("sources", {})
            status.setdefault("model_catalogs", {})
        except json.JSONDecodeError:
            pass
    status["generated_at"] = now_iso()

    summary = []
    for source in sources:
        repo_dir, commit = ensure_repo(source)
        discovered, updated = scan_source(source, repo_dir, commit)
        previous = status["sources"].get(source["source_id"], {})
        status["sources"][source["source_id"]] = {
            "repo": source["repo"],
            "branch": source.get("branch", "main"),
            "cached_path": str(repo_dir.relative_to(HR_HOME)),
            "last_checked": now_iso(),
            "commit": commit,
            "discovered_count": discovered,
            "updated_cards": updated,
            "previous_commit": previous.get("commit"),
        }
        summary.append(
            f"- {source['source_id']}: {source['repo']} @ {commit[:12]} ({updated} cards)"
        )

    for model_source in model_sources:
        provider_count, model_count = sync_model_catalog(model_source)
        previous = status["model_catalogs"].get(model_source["source_id"], {})
        status["model_catalogs"][model_source["source_id"]] = {
            "url": model_source["url"],
            "format": model_source.get("format", "models.dev"),
            "last_checked": now_iso(),
            "provider_count": provider_count,
            "model_count": model_count,
            "catalog_path": str(MODEL_CATALOG_PATH.relative_to(HR_HOME)),
            "model_ids_path": str(MODEL_IDS_PATH.relative_to(HR_HOME)),
            "previous_model_count": previous.get("model_count"),
        }
        summary.append(
            f"- {model_source['source_id']}: {model_source['url']} ({model_count} models across {provider_count} providers)"
        )

    write_json(STATUS_PATH, status)
    summary_path = INVENTORY_ROOT / "SUMMARY.md"
    if summary:
        summary_text = "# Inventory Sync Summary\n\n" + "\n".join(summary) + "\n"
    else:
        summary_text = "# Inventory Sync Summary\n\n- No GitHub sources configured in hr-config.json\n"
    summary_path.write_text(summary_text, encoding="utf-8")
    print(summary_text)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"sync failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
