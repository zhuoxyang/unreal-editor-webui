#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from typing import List, Optional

sys.dont_write_bytecode = True

from tool_pack_distribution import (
    DistributionError,
    doctor_error_document,
    doctor_internal_error_document,
    doctor_installation,
    render_doctor_human,
    render_json,
)


class SafeArgumentParser(argparse.ArgumentParser):
    def error(self, _message: str) -> None:
        self.print_usage(sys.stderr)
        self.exit(2, "error: invalid command line\n")


def _configure_streams() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="strict", newline="\n")


def main(argv: Optional[List[str]] = None) -> int:
    _configure_streams()
    parser = SafeArgumentParser(
        description="Read-only diagnosis for an Unreal Editor WebUI Tool Pack installation.",
    )
    parser.add_argument("--project", required=True)
    parser.add_argument("--engine-root", required=True)
    parser.add_argument(
        "--external-root",
        action="append",
        default=[],
        dest="external_roots",
    )
    parser.add_argument("--trust-file")
    parser.add_argument(
        "--format",
        choices=("human", "json"),
        default="human",
    )
    args = parser.parse_args(argv)
    try:
        report = doctor_installation(
            args.project,
            args.engine_root,
            args.external_roots,
            trust_file_value=args.trust_file,
        )
    except DistributionError as error:
        if args.format == "json":
            sys.stdout.write(render_json(doctor_error_document(error)))
        else:
            sys.stderr.write(
                "ERROR %s [%s] %s\n"
                % (error.plugin_name, error.reason_code, error.message)
            )
        return 1
    except Exception:
        if args.format == "json":
            sys.stdout.write(render_json(doctor_internal_error_document()))
        else:
            sys.stderr.write("ERROR internal [internal_error] Tool Pack doctor failed unexpectedly.\n")
        return 3
    if args.format == "json":
        sys.stdout.write(render_json(report.public_document()))
    else:
        sys.stdout.write(render_doctor_human(report))
    return 0 if report.healthy else 1


if __name__ == "__main__":
    raise SystemExit(main())
