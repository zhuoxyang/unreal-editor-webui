#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from typing import List, Optional

sys.dont_write_bytecode = True

from tool_pack_distribution import (
    DistributionError,
    internal_error_document,
    package_error_document,
    package_tool_pack,
    render_json,
    render_package_human,
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
        description="Create a reproducible Unreal Editor WebUI Tool Pack archive.",
    )
    parser.add_argument("--plugin-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument(
        "--engine-root",
        help="Required for a Tool Pack hosted by a code plugin.",
    )
    parser.add_argument(
        "--format",
        choices=("human", "json"),
        default="human",
    )
    args = parser.parse_args(argv)
    try:
        result = package_tool_pack(
            args.plugin_dir,
            args.output_dir,
            engine_root_value=args.engine_root,
        )
    except DistributionError as error:
        if args.format == "json":
            sys.stdout.write(render_json(package_error_document(error)))
        else:
            sys.stderr.write(
                "ERROR %s [%s] %s\n"
                % (error.plugin_name, error.reason_code, error.message)
            )
        return 1
    except Exception:
        if args.format == "json":
            sys.stdout.write(render_json(internal_error_document("Tool Pack packager")))
        else:
            sys.stderr.write("ERROR internal [internal_error] Tool Pack packager failed unexpectedly.\n")
        return 3
    if args.format == "json":
        sys.stdout.write(render_json(result.public_document()))
    else:
        sys.stdout.write(render_package_human(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
