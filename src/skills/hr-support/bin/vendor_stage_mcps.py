#!/usr/bin/env python3

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


def resolve_hr_home() -> Path:
    explicit = os.environ.get("OPENCODE_AGENTHUB_HR_HOME")
    if explicit:
        return Path(explicit).resolve()
    return Path(__file__).resolve().parent.parent


def resolve_builtin_mcp_root() -> Path | None:
    this_file = Path(__file__).resolve()
    parts = this_file.parts
    if (
        len(parts) >= 6
        and parts[-2] == "bin"
        and parts[-3] == "hr-support"
        and parts[-4] == "skills"
        and parts[-5] == "src"
    ):
        candidate = this_file.parents[3] / "composer" / "library" / "mcp"
        if candidate.exists():
            return candidate
    return None


HR_HOME = resolve_hr_home()
WORKERS_ROOT = HR_HOME / "inventory" / "workers"
BUILTIN_MCP_ROOT = resolve_builtin_mcp_root()


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


def load_worker_cards() -> list[dict]:
    cards: list[dict] = []
    for worker_file in sorted(WORKERS_ROOT.glob("*.json")):
        try:
            cards.append(read_json(worker_file))
        except json.JSONDecodeError:
            continue
    return cards


def find_source_root(mcp_name: str, cards: list[dict]) -> Path | None:
    normalized = mcp_name.lower()
    for card in cards:
        if card.get("asset_kind") != "profile":
            continue
        selected = card.get("selected_mcps") or []
        if normalized not in {str(item).lower() for item in selected}:
            continue
        cached_repo = card.get("artifacts", {}).get("cached_repo")
        if not cached_repo:
            continue
        repo_root = Path(cached_repo)
        if not repo_root.is_absolute():
            repo_root = HR_HOME / repo_root
        if (repo_root / "mcp" / f"{mcp_name}.json").exists():
            return repo_root
    return None


def copy_tree_if_exists(source: Path, target: Path) -> None:
    if not source.exists():
        return
    if source.is_dir():
        shutil.copytree(source, target, dirs_exist_ok=True)
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


def resolve_library_root_from_command(command: list[object]) -> str | None:
    for item in command:
        if isinstance(item, str) and "${LIBRARY_ROOT}" in item:
            suffix = item.split("${LIBRARY_ROOT}/", 1)
            if len(suffix) == 2:
                return suffix[1]
    return None


def command_available(name: str) -> bool:
    return shutil.which(name) is not None


def install_mcp_dependencies(target_root: Path) -> str:
    if command_available("bun"):
        subprocess.run(["bun", "install"], cwd=target_root, check=True)
        return "bun"
    if command_available("npm"):
        subprocess.run(["npm", "install"], cwd=target_root, check=True)
        return "npm"
    raise SystemExit(
        "MCP dependencies are required but neither 'bun' nor 'npm' is available on PATH."
    )


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit(
            "Usage: vendor_stage_mcps.py <stage-package-root|agenthub-home-root>"
        )

    import_root = resolve_import_root(sys.argv[1])
    bundles_root = import_root / "bundles"
    staged_mcp_root = import_root / "mcp"
    staged_mcp_servers_root = import_root / "mcp-servers"
    staged_mcp_root.mkdir(parents=True, exist_ok=True)

    required_mcps: set[str] = set()
    for bundle_file in sorted(bundles_root.glob("*.json")):
        bundle = read_json(bundle_file)
        for mcp_name in bundle.get("mcp", []):
            required_mcps.add(str(mcp_name))

    if not required_mcps:
        print("Vendored MCPs:\n- none required")
        return 0

    cards = load_worker_cards()
    vendored_mcps: list[str] = []
    vendored_servers: set[str] = set()
    deferred_install_paths: set[str] = set()

    for mcp_name in sorted(required_mcps):
        source_root = find_source_root(mcp_name, cards)
        if source_root is None:
            raise SystemExit(
                f"Missing cached source repo for MCP '{mcp_name}'. Add a worker card with selected_mcps and cached_repo."
            )

        source_mcp_file = source_root / "mcp" / f"{mcp_name}.json"
        if not source_mcp_file.exists():
            builtin_candidate = (
                BUILTIN_MCP_ROOT / f"{mcp_name}.json" if BUILTIN_MCP_ROOT else None
            )
            if builtin_candidate and builtin_candidate.exists():
                source_mcp_file = builtin_candidate
            else:
                raise SystemExit(
                    f"Missing MCP registration for '{mcp_name}' in {source_root / 'mcp'}"
                )

        target_mcp_file = staged_mcp_root / f"{mcp_name}.json"
        target_mcp_file.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_mcp_file, target_mcp_file)
        vendored_mcps.append(mcp_name)

        config = read_json(source_mcp_file)
        command = config.get("command") or []
        if not isinstance(command, list):
            continue
        for entry in command:
            if not isinstance(entry, str) or "${LIBRARY_ROOT}/" not in entry:
                continue
            relative = resolve_library_root_from_command([entry])
            if not relative:
                continue
            source_path = source_root / relative
            if "mcp-servers/" not in relative:
                continue
            if relative.startswith("mcp-servers/node_modules/"):
                package_manifest = source_root / "mcp-servers" / "package.json"
                if package_manifest.exists():
                    deferred_install_paths.add(relative)
                    continue
            if not source_path.exists():
                raise SystemExit(
                    f"MCP '{mcp_name}' references '{relative}' but it does not exist under {source_root}"
                )
            target_path = import_root / relative
            copy_tree_if_exists(source_path, target_path)
            vendored_servers.add(relative)

        package_manifest = source_root / "mcp-servers" / "package.json"
        if package_manifest.exists():
            copy_tree_if_exists(
                package_manifest, staged_mcp_servers_root / "package.json"
            )
            vendored_servers.add("mcp-servers/package.json")

    install_tool: str | None = None
    if deferred_install_paths:
        missing_after_copy = [
            relative
            for relative in sorted(deferred_install_paths)
            if not (import_root / relative).exists()
        ]
        if missing_after_copy:
            if not (staged_mcp_servers_root / "package.json").exists():
                detail = ", ".join(missing_after_copy)
                raise SystemExit(
                    f"MCP configs reference runtime dependencies ({detail}) but no staged mcp-servers/package.json is available."
                )
            install_tool = install_mcp_dependencies(staged_mcp_servers_root)
            for relative in missing_after_copy:
                if not (import_root / relative).exists():
                    raise SystemExit(
                        f"Installed MCP dependencies with {install_tool}, but required runtime file is still missing: {relative}"
                    )
                vendored_servers.add(relative)

    print("Vendored MCP configs:")
    for name in vendored_mcps:
        print(f"- {name}")
    print("Vendored MCP server artifacts:")
    for relative in sorted(vendored_servers):
        print(f"- {relative}")
    if install_tool:
        print(f"Installed MCP dependencies with: {install_tool}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
