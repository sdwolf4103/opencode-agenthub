#!/usr/bin/env python3

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def wrap_executable(command: str) -> list[str]:
    path = Path(command)
    suffix = path.suffix.lower()
    if suffix == ".js":
        return ["node", command]
    if os.name == "nt" and suffix in {".cmd", ".bat"}:
        return ["cmd", "/c", command]
    return [command]


def resolve_agenthub_command() -> list[str]:
    if os.getenv("OPENCODE_AGENTHUB_BIN"):
        return wrap_executable(os.environ["OPENCODE_AGENTHUB_BIN"])
    found = shutil.which("opencode-agenthub")
    if found:
        return wrap_executable(found)
    # Portable repo-local fallback: when running from src/skills/hr-support/bin/
    # inside the source tree, try <repo-root>/bin/opencode-agenthub
    this_file = Path(__file__).resolve()
    parts = this_file.parts
    # Expected: .../<repo>/src/skills/hr-support/bin/validate_staged_package.py
    # so repo root is 4 levels up from this file's directory
    if (
        len(parts) >= 6
        and parts[-2] == "bin"
        and parts[-3] == "hr-support"
        and parts[-4] == "skills"
        and parts[-5] == "src"
    ):
        repo_bin_cmd = this_file.parents[4] / "bin" / "opencode-agenthub.cmd"
        if os.name == "nt" and repo_bin_cmd.exists():
            return ["cmd", "/c", str(repo_bin_cmd)]
        repo_bin = this_file.parents[4] / "bin" / "opencode-agenthub"
        if os.name != "nt" and repo_bin.exists():
            return [str(repo_bin)]
        repo_dist = this_file.parents[4] / "dist" / "composer" / "opencode-profile.js"
        if repo_dist.exists():
            return ["node", str(repo_dist)]
    raise SystemExit(
        "Could not locate opencode-agenthub.\n"
        "  Set OPENCODE_AGENTHUB_BIN to the full path, or add opencode-agenthub to PATH.\n"
        "  When running from source, ensure bin/opencode-agenthub (or .cmd on Windows) exists, or build dist/composer/opencode-profile.js in the repo root."
    )


def run(cmd: list[str], env: dict[str, str] | None = None) -> None:
    result = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if result.returncode != 0:
        message = result.stderr.strip() or result.stdout.strip()
        raise SystemExit(f"Command failed: {' '.join(cmd)}\n{message}")


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


def validate_bundle_metadata(import_root: Path) -> None:
    forbidden = {"optional_skills", "runtime_conditional_skills"}
    violations: list[str] = []
    for bundle_file in sorted((import_root / "bundles").glob("*.json")):
        bundle = read_json(bundle_file)
        metadata = bundle.get("metadata", {})
        if not isinstance(metadata, dict):
            continue
        bad = sorted(forbidden.intersection(metadata.keys()))
        if bad:
            violations.append(f"{bundle_file.name}: {', '.join(bad)}")
    if violations:
        detail = "\n".join(f"- {item}" for item in violations)
        raise SystemExit(
            "Bundle metadata contains non-runtime semantic keys that the current platform does not consume:\n"
            f"{detail}"
        )


def validate_staged_skills(import_root: Path) -> None:
    skills_root = import_root / "skills"
    missing: list[str] = []
    for bundle_file in sorted((import_root / "bundles").glob("*.json")):
        bundle = read_json(bundle_file)
        for skill_name in bundle.get("skills", []):
            if not (skills_root / skill_name).exists():
                missing.append(f"{bundle_file.name}: {skill_name}")
    if missing:
        detail = "\n".join(f"- {item}" for item in missing)
        raise SystemExit(f"Missing staged skills referenced by bundles:\n{detail}")


def validate_staged_mcps(import_root: Path) -> None:
    mcp_root = import_root / "mcp"
    bundles_root = import_root / "bundles"
    if not bundles_root.exists():
        return

    missing_configs: list[str] = []
    missing_servers: list[str] = []

    for bundle_file in sorted(bundles_root.glob("*.json")):
        bundle = read_json(bundle_file)
        for mcp_name in bundle.get("mcp", []):
            config_path = mcp_root / f"{mcp_name}.json"
            if not config_path.exists():
                missing_configs.append(f"{bundle_file.name}: {mcp_name}")

    if missing_configs:
        detail = "\n".join(f"- {item}" for item in missing_configs)
        raise SystemExit(f"Missing staged MCP configs referenced by bundles:\n{detail}")

    if not mcp_root.exists():
        return

    for mcp_file in sorted(mcp_root.glob("*.json")):
        config = read_json(mcp_file)
        command = config.get("command", [])
        if not isinstance(command, list):
            continue
        for item in command:
            if not isinstance(item, str) or "${LIBRARY_ROOT}/" not in item:
                continue
            relative = item.split("${LIBRARY_ROOT}/", 1)[1]
            if not relative.startswith("mcp-servers/"):
                continue
            target = import_root / relative
            if not target.exists():
                missing_servers.append(f"{mcp_file.name}: {relative}")

    if missing_servers:
        detail = "\n".join(f"- {item}" for item in missing_servers)
        raise SystemExit(
            f"Missing staged MCP server artifacts referenced by MCP configs:\n{detail}"
        )


def validate_profile_default_agents(import_root: Path) -> None:
    bundle_specs = {
        bundle_file.stem: read_json(bundle_file)
        for bundle_file in sorted((import_root / "bundles").glob("*.json"))
    }

    for profile_file in sorted((import_root / "profiles").glob("*.json")):
        profile = read_json(profile_file)
        profile_name = profile.get("name") or profile_file.stem
        bundle_names = profile.get("bundles", [])
        if not isinstance(bundle_names, list):
            raise SystemExit(
                f"Profile '{profile_name}' has invalid bundles metadata; expected a list."
            )

        references: list[tuple[str, str]] = []
        missing_bundles: list[str] = []
        for raw_bundle_name in bundle_names:
            if not isinstance(raw_bundle_name, str) or not raw_bundle_name.strip():
                raise SystemExit(
                    f"Profile '{profile_name}' contains an invalid bundle reference: {raw_bundle_name!r}."
                )
            bundle_name = raw_bundle_name.strip()
            bundle = bundle_specs.get(bundle_name)
            if not bundle:
                missing_bundles.append(bundle_name)
                continue
            agent = bundle.get("agent", {})
            agent_name = agent.get("name") if isinstance(agent, dict) else None
            if not isinstance(agent_name, str) or not agent_name.strip():
                raise SystemExit(
                    f"Bundle '{bundle_name}' is missing required agent.name; profile '{profile_name}' cannot use it."
                )
            references.append((bundle_name, agent_name.strip()))

        if missing_bundles:
            detail = ", ".join(missing_bundles)
            raise SystemExit(
                f"Profile '{profile_name}' references missing bundle(s): {detail}."
            )

        default_agent = profile.get("defaultAgent")
        native_agent_policy = profile.get("nativeAgentPolicy")
        if native_agent_policy == "team-only" and default_agent is None:
            raise SystemExit(
                f"Profile '{profile_name}' uses nativeAgentPolicy 'team-only' and must set defaultAgent explicitly."
            )
        if default_agent is None:
            continue
        if not isinstance(default_agent, str) or not default_agent.strip():
            raise SystemExit(
                f"Profile '{profile_name}' has an invalid defaultAgent value: {default_agent!r}."
            )

        normalized_default_agent = default_agent.strip()
        bundle_match = next(
            (
                agent_name
                for bundle_name, agent_name in references
                if bundle_name == normalized_default_agent
                and agent_name != normalized_default_agent
            ),
            None,
        )
        if bundle_match:
            raise SystemExit(
                f"Profile '{profile_name}' defaultAgent '{normalized_default_agent}' does not match any bundle agent.name. "
                f"Bundle '{normalized_default_agent}' uses bundle agent.name '{bundle_match}'. Set defaultAgent to that value."
            )

        agent_names = {agent_name for _, agent_name in references}
        if normalized_default_agent in agent_names:
            continue

        available = ", ".join(sorted(agent_names)) or "(none)"
        raise SystemExit(
            f"Profile '{profile_name}' defaultAgent '{normalized_default_agent}' does not match any bundle agent.name. "
            f"Available bundle agent.name values: {available}."
        )


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit(
            "Usage: validate_staged_package.py <stage-package-root|agenthub-home-root>"
        )

    import_root = resolve_import_root(sys.argv[1])
    workspace_root = Path.cwd()
    validate_bundle_metadata(import_root)
    validate_staged_skills(import_root)
    validate_staged_mcps(import_root)
    validate_profile_default_agents(import_root)

    profiles = sorted(p.stem for p in (import_root / "profiles").glob("*.json"))
    if not profiles:
        raise SystemExit("No profiles found in staged import root.")

    # Integration smoke phase below requires a runnable agenthub binary.
    agenthub_cmd = resolve_agenthub_command()

    with tempfile.TemporaryDirectory(prefix="agenthub-stage-validate-") as temp_dir:
        temp_root = Path(temp_dir)
        temp_home = temp_root / "home"
        temp_hr_home = temp_root / "hr-home"
        temp_cfg = temp_root / "config"

        run(
            [
                *agenthub_cmd,
                "setup",
                "minimal",
                "--target-root",
                str(temp_home),
            ]
        )
        run(
            [
                *agenthub_cmd,
                "hub-import",
                "--source",
                str(import_root),
                "--target-root",
                str(temp_home),
                "--overwrite",
            ]
        )

        env = os.environ.copy()
        env["OPENCODE_AGENTHUB_HOME"] = str(temp_home)
        env["OPENCODE_AGENTHUB_HR_HOME"] = str(temp_hr_home)
        for profile in profiles:
            run(
                [
                    *agenthub_cmd,
                    "run",
                    profile,
                    "--workspace",
                    str(workspace_root),
                    "--config-root",
                    str(temp_cfg / profile),
                    "--assemble-only",
                ],
                env=env,
            )

    print("VALIDATED")
    print(f"- import_root: {import_root}")
    print(f"- profiles: {', '.join(profiles)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
