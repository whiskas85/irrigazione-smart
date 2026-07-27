#!/usr/bin/env python3
"""Bump di versione per irrigazione_smart.

Fonte di verità unica: il campo `version` di manifest.json.
HACS legge quello per sapere quale versione ha installato, e legge i
*tag git* per sapere quali versioni sono disponibili. Se i due divergono,
HACS mostra aggiornamenti fantasma. Questo script li tiene allineati.

Uso:
    python scripts/bump.py patch      # 0.1.0 -> 0.1.1
    python scripts/bump.py minor      # 0.1.1 -> 0.2.0
    python scripts/bump.py major      # 0.2.0 -> 1.0.0
    python scripts/bump.py 0.5.2      # versione esplicita

    python scripts/bump.py patch --dry-run    # mostra e basta
    python scripts/bump.py patch --no-tag     # non crea commit/tag
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "custom_components" / "irrigazione_smart" / "manifest.json"
CHANGELOG = ROOT / "CHANGELOG.md"

SEMVER_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")


def read_version() -> str:
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    version = data.get("version")
    if not version or not SEMVER_RE.match(version):
        sys.exit(f"Versione non valida in {MANIFEST.name}: {version!r}")
    return version


def next_version(current: str, bump: str) -> str:
    if SEMVER_RE.match(bump):
        return bump

    major, minor, patch = (int(p) for p in current.split("."))
    if bump == "major":
        return f"{major + 1}.0.0"
    if bump == "minor":
        return f"{major}.{minor + 1}.0"
    if bump == "patch":
        return f"{major}.{minor}.{patch + 1}"
    sys.exit(f"Bump non riconosciuto: {bump!r}")


def write_manifest(version: str) -> None:
    """Riscrive solo il campo version, preservando l'ordine delle chiavi."""
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    data["version"] = version
    MANIFEST.write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )


def update_changelog(version: str) -> bool:
    """Promuove la sezione [Unreleased] a versione datata.

    Il match è ancorato alla riga esatta: il testo introduttivo del
    changelog cita la sezione per nome, e una ricerca per sottostringa
    spezzerebbe sul punto sbagliato.

    Ritorna False se non c'è nulla da rilasciare: pubblicare una versione
    senza voci di changelog è quasi sempre un errore.
    """
    if not CHANGELOG.exists():
        return False

    lines = CHANGELOG.read_text(encoding="utf-8").splitlines()

    heading = next(
        (i for i, line in enumerate(lines) if line.strip() == "## [Unreleased]"),
        None,
    )
    if heading is None:
        return False

    end = len(lines)
    for i in range(heading + 1, len(lines)):
        if lines[i].startswith("## "):
            end = i
            break

    body = lines[heading + 1 : end]
    while body and not body[0].strip():
        body.pop(0)
    while body and not body[-1].strip():
        body.pop()

    if not body:
        return False

    updated = (
        lines[: heading + 1]
        + ["", f"## [{version}] - {date.today().isoformat()}", ""]
        + body
        + [""]
        + lines[end:]
    )
    CHANGELOG.write_text("\n".join(updated).rstrip() + "\n", encoding="utf-8")
    return True


def git(*args: str) -> None:
    subprocess.run(["git", *args], cwd=ROOT, check=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bump", help="major | minor | patch | X.Y.Z")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--no-tag", action="store_true")
    parser.add_argument(
        "--allow-empty-changelog",
        action="store_true",
        help="rilascia anche senza voci in [Unreleased]",
    )
    args = parser.parse_args()

    current = read_version()
    target = next_version(current, args.bump)

    if target == current:
        sys.exit(f"La versione è già {current}")

    print(f"  {current}  ->  {target}")

    if args.dry_run:
        print("  (dry-run: nessuna modifica scritta)")
        return

    had_entries = update_changelog(target)
    if not had_entries and not args.allow_empty_changelog:
        sys.exit(
            "\n  CHANGELOG.md non ha voci in [Unreleased].\n"
            "  Descrivi cosa cambia, oppure usa --allow-empty-changelog."
        )

    write_manifest(target)
    print(f"  manifest.json aggiornato")
    if had_entries:
        print(f"  CHANGELOG.md aggiornato")

    if args.no_tag:
        print("\n  Commit e tag saltati (--no-tag)")
        return

    git("add", str(MANIFEST), str(CHANGELOG))
    git("commit", "-m", f"release: v{target}")
    git("tag", "-a", f"v{target}", "-m", f"v{target}")

    print(
        f"\n  Commit e tag v{target} creati.\n"
        f"  Per pubblicare:\n"
        f"      git push && git push --tags"
    )


if __name__ == "__main__":
    main()
