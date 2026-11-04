#!/usr/bin/env python3
"""Harness-driven verification of the portal AI layer (sovereign-harness 0.5.1).

Runs the portal's AI-layer claims manifests through Sovereign-Harness's
panel + judge verification (`python -m harness.cli verify`), with the panel
and judge pinned to Muse models ONLY, then verifies the harness autonomy
ledger's hash chain. This is an eval/verification-time integration: the
portal at request time calls api.meta.ai directly from its Cloudflare
proxy (see README.md in this directory for the evidence and for what this
does NOT claim).

Model invariant (enforced here, not by convention):
  * every panel/judge model id must be in ALLOWED_MODELS (bare Meta API
    ids on the harness's direct Meta lane, api.meta.ai); anything else
    aborts before any call;
  * HARNESS_USE_FREE=false is forced, so no free-pool rotation can bring a
    non-Muse model into the run; judge fallbacks are drawn only from the
    panel pool above, which is Muse-only;
  * HARNESS_MODEL_PRESET=muse and HARNESS_META_BUDGET_USD are forced in
    the subprocess env (see the env block in main): the preset is what
    routes bare muse- ids to the direct Meta lane instead of OpenRouter,
    and the local Meta budget defaults to 0.0 in the harness -- a cap of
    zero refuses every Meta call;
  * the spend governor's pre-flight ceiling (--max-cost) refuses the run
    before dispatch if the worst case exceeds it.

Credentials: the harness resolves its Meta (Muse) API key itself
(harness.config.resolve_meta_key): ~/.config/scmorc/meta.env, then
~/.config/harness/meta.env, then $META_API_KEY / $MUSE_API_KEY in the
environment. The key is the Muse API key (the $150 hackathon credits);
OpenRouter is not involved on this rail. No key is read, printed, or
stored by this script.

Usage:
  python3 run_harness_verify.py [--out-dir DIR] [--max-cost 1.00]
                                [--only meta-client|answer] [--dry-run]
Exit: 0 = every defect claim rejected by panel+judge and ledger chain ok;
      1 = a claim was upheld / ledger failed / harness run failed;
      2 = setup problem (version, key, model invariant).
"""
import argparse, json, os, subprocess, sys, time
from pathlib import Path

REQUIRED_VERSION = "0.5.1"
# Muse-only pinning (owner directive 2026-11-03): bare Meta API ids on
# the harness's direct Meta lane (api.meta.ai, priced from the committed
# offers in harness/meta.py) -- never OpenRouter slugs. A bare muse- id
# with no committed offer fails closed at pricing time.
ALLOWED_MODELS = {"muse-spark-1.3", "muse-wonder-1.0"}
PANEL = ["muse-spark-1.3", "muse-wonder-1.0"]  # strongest/preferred first
JUDGE = "muse-wonder-1.0"
# The structured-claims convergence specialist defaults to a non-Muse model
# in harness.config (observed in a live preflight reserve, 2026-11-02:
# 'z-ai/glm-5.3-flash (convergence attempt ...)'). It is therefore pinned
# explicitly on every run; without these two settings the Muse-only
# invariant does NOT hold even with a Muse-only panel and judge. The seat
# renders the structured tally -- the cheap rung of the panel's shape --
# so it is pinned to Spark; Wonder stays where the decision weight is
# (the judge). The specialist pool is the seat's fallback set.
CONVERGENCE_MODEL = "muse-spark-1.3"
SPECIALIST_POOL = ["muse-spark-1.3", "muse-wonder-1.0"]
HERE = Path(__file__).resolve().parent


def fail(code, msg):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(code)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", default=str(HERE / "results"))
    ap.add_argument("--max-cost", type=float, default=1.00, help="per-manifest USD ceiling (pre-flight, fail-closed)")
    ap.add_argument("--only", choices=["meta-client", "answer"])
    ap.add_argument("--dry-run", action="store_true", help="print the exact commands; make no model calls")
    args = ap.parse_args()

    # Model invariant first: cheap, local, and before any subprocess.
    for m in PANEL + [JUDGE, CONVERGENCE_MODEL] + SPECIALIST_POOL:
        if m not in ALLOWED_MODELS:
            fail(2, f"model {m!r} is not in the Muse-only allowlist {sorted(ALLOWED_MODELS)}")

    try:
        import importlib.metadata as md
        version = md.version("sovereign-harness")
    except Exception:
        fail(2, "sovereign-harness is not installed in this Python environment; "
                "install the pinned release: pip install sovereign-harness==0.5.1")
    if version != REQUIRED_VERSION:
        fail(2, f"sovereign-harness {version} installed; this path is pinned to {REQUIRED_VERSION}")

    # (Re)build claims from current source so refs can never go stale silently.
    r = subprocess.run([sys.executable, str(HERE / "build_claims.py"), "--out", str(HERE)],
                       capture_output=True, text=True)
    if r.returncode != 0:
        fail(2, f"build_claims.py failed:\n{r.stdout}\n{r.stderr}")

    env = dict(os.environ)
    env["HARNESS_USE_FREE"] = "false"  # no free-pool rotation into this run
    # The Muse rail is carried by the runner itself, not by whoever
    # invokes it: recorded runs through 2026-11-03 left the preset unset
    # by hand, which is exactly what kept them on OpenRouter. The preset
    # re-pins every harness surface to bare Meta ids and makes the
    # governor skip OpenRouter key verification entirely.
    env["HARNESS_MODEL_PRESET"] = "muse"
    # The local Meta budget is this rail's spend control. Its harness
    # default is 0.0, and a cap of zero refuses every Meta call
    # (spend.assert_meta_budget) -- forgetting it fails the run closed
    # before its first call. $2.00 mirrors the two $1.00 --max-cost
    # manifest ceilings.
    env["HARNESS_META_BUDGET_USD"] = "2.00"

    stamp = time.strftime("%Y%m%d-%H%M%S")
    out_dir = Path(args.out_dir) / stamp
    names = [args.only] if args.only else ["meta-client", "answer"]
    summary = {"harness_version": version, "panel": PANEL, "judge": JUDGE,
               "convergence_model": CONVERGENCE_MODEL, "specialist_pool": SPECIALIST_POOL,
               "max_cost_usd_per_manifest": args.max_cost, "runs": []}
    overall_ok = True

    for name in names:
        result_path = out_dir / f"result-{name}.json"
        events_path = out_dir / f"events-{name}.jsonl"
        cmd = [sys.executable, "-m", "harness.cli", "verify",
               "--claims-file", str(HERE / f"claims-{name}.json"),
               "--source-file", str(HERE / f"excerpt-{name}.txt"),
               "--panel", ",".join(PANEL), "--judge", JUDGE,
               "--convergence-model", CONVERGENCE_MODEL,
               "--specialist-pool", ",".join(SPECIALIST_POOL),
               "--max-cost", str(args.max_cost),
               "--task-id", f"civicscope-ai-{name}",
               "--out", str(result_path), "--events", str(events_path), "--quiet"]
        print(f"[{name}] {' '.join(cmd)}")
        if args.dry_run:
            summary["runs"].append({"manifest": name, "dry_run": True})
            continue
        out_dir.mkdir(parents=True, exist_ok=True)
        proc = subprocess.run(cmd, env=env, capture_output=True, text=True)
        entry = {"manifest": name, "exit_code": proc.returncode,
                 "result_file": str(result_path)}
        if proc.returncode != 0:
            entry["stderr_tail"] = proc.stderr[-2000:]
            overall_ok = False
        # Post-run invariant audit: every model the events file records --
        # preflight reserves included -- must be Muse-only. A reserve for a
        # non-Muse model is a violation even if that call never dispatched.
        if events_path.exists():
            seen = set()
            for line in events_path.read_text(encoding="utf-8").splitlines():
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                if isinstance(ev.get("model"), str):
                    seen.add(ev["model"])
                for call in ev.get("calls") or []:
                    if isinstance(call.get("model"), str):
                        seen.add(call["model"])
            entry["models_seen_in_events"] = sorted(seen)
            entry["non_muse_models_seen"] = sorted(seen - ALLOWED_MODELS)
            if entry["non_muse_models_seen"]:
                overall_ok = False
        if result_path.exists():
            try:
                entry["result"] = json.loads(result_path.read_text(encoding="utf-8"))
            except ValueError:
                entry["result_parse_error"] = True
                overall_ok = False
        summary["runs"].append(entry)

    if not args.dry_run:
        # Audit chain: the autonomy ledger every harness run writes to.
        proc = subprocess.run([sys.executable, "-m", "harness.cli", "ledger", "verify"],
                              env=env, capture_output=True, text=True)
        summary["ledger_verify"] = {"exit_code": proc.returncode,
                                    "output_tail": (proc.stdout + proc.stderr)[-2000:]}
        if proc.returncode != 0:
            overall_ok = False
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
        print(f"summary: {out_dir / 'summary.json'}")
    print("OVERALL:", "DRY-RUN" if args.dry_run else ("PASS" if overall_ok else "CHECK summary.json"))
    return 0 if (args.dry_run or overall_ok) else 1


if __name__ == "__main__":
    sys.exit(main())
