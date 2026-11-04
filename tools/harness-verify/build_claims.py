#!/usr/bin/env python3
"""Build Sovereign-Harness claims manifests for the portal AI layer.

Each manifest pairs DEFECT claims (failure modes the shipped code must NOT
have) with a verbatim excerpt of the source file under review. source_refs
are computed from anchor substrings inside the excerpt, never hand-typed,
so a ref that no longer resolves fails the build loudly instead of letting
the panel judge a claim against the wrong lines.

Usage: python3 build_claims.py [--repo ROOT] [--out DIR]
Outputs: claims-meta-client.json, excerpt-meta-client.txt,
         claims-answer.json, excerpt-answer.txt  (into --out, default: here)
"""
import argparse, json, sys
from pathlib import Path

# (source file, [(start, end) 1-based inclusive ranges]) -- verbatim slices.
TARGETS = {
    "meta-client": (
        "src/core/ai/meta-client.ts",
        [(44, 68), (313, 348), (725, 765), (781, 835)],
        [
            {
                "id": "mc-model",
                "text": "DEFECT: the shipped runtime model constant names a model other than Muse Spark 1.3, so the portal's chat calls can run on a non-Muse model",
                "anchors": ["MUSE_SPARK_MODEL = 'muse-spark-1.3'"],
            },
            {
                "id": "mc-research-ungrounded",
                "text": "DEFECT: the research path returns prose with an empty source list as a valid research result, presenting ungrounded prose as web findings",
                "anchors": ["if (!prose || sources.length === 0) throw new ProviderCallError('provider_down')"],
            },
            {
                "id": "mc-research-unscanned",
                "text": "DEFECT: research prose reaches the caller with no banned-construction (fair-housing) scan on this direct provider path",
                "anchors": ["const filtered = filterBannedSentences(prose)"],
            },
            {
                "id": "mc-asr-chat-model",
                "text": "DEFECT: transcription is sent to the chat model instead of the dedicated Muse Voice Transcribe ASR model on its own endpoint",
                "anchors": ["ASR_MODEL = 'muse-voice-transcribe-1.0'", "}/asr/transcribe`"],
            },
        ],
    ),
    "answer": (
        "src/core/ai/answer.ts",
        [(4058, 4143), (5181, 5193), (5465, 5476)],
        [
            {
                "id": "ans-figure-drift",
                "text": "DEFECT: the answer pipeline can return status verified when a figure on the answer differs from the screened Census row it was copied from",
                "anchors": ["figure mismatch for", "status: 'withheld', stage: 'verify'"],
            },
            {
                "id": "ans-uncited-claim",
                "text": "DEFECT: an uncited researched claim, or a claim citing a source the answer does not carry, can survive into a verified answer",
                "anchors": ["uncited researched claim survived compose", "claim cites a source the answer does not carry"],
            },
            {
                "id": "ans-fail-open",
                "text": "DEFECT: a composed answer that fails the verify stage is still returned with status verified (the verify gate is not fail-closed)",
                "anchors": ["status: 'withheld', stage: 'verify'"],
            },
        ],
    ),
}

CONTEXT = {
    "meta-client": (
        "CivicScope portal AI client (TypeScript). The portal's claims are: runtime AI is Muse models only "
        "(Muse Spark 1.3 for chat, Muse Voice Transcribe for ASR, both on api.meta.ai); research prose is "
        "citation-gated and fair-housing scanned before it can be shown. Each claim below asserts a DEFECT; "
        "judge from the quoted source window only: a claim is supported only if the window shows the defect."
    ),
    "answer": (
        "CivicScope staged answer pipeline (TypeScript): parse -> deterministic Census screen -> research over "
        "the screened subset -> compose -> fail-closed verify. Each claim below asserts a DEFECT; judge from "
        "the quoted source window only: a claim is supported only if the window shows the defect."
    ),
}


def build(repo: Path, name: str, rel: str, ranges, claim_specs):
    lines = (repo / rel).read_text(encoding="utf-8").splitlines()
    excerpt_lines, mapping = [], []  # mapping: excerpt line (1-based) -> source line
    for start, end in ranges:
        for src_line in range(start, end + 1):
            excerpt_lines.append(lines[src_line - 1])
            mapping.append(src_line)
    excerpt = "\n".join(excerpt_lines) + "\n"

    claims = []
    for spec in claim_specs:
        refs = []
        for anchor in spec["anchors"]:
            hits = [i + 1 for i, l in enumerate(excerpt_lines) if anchor in l]
            if not hits:
                raise SystemExit(f"[{name}] anchor not found in excerpt of {rel}: {anchor!r}")
            refs.append(hits[0])
        claims.append({"id": spec["id"], "text": spec["text"], "kind": "defect",
                       "source_refs": sorted(set(refs))})
    manifest = {"context": CONTEXT[name], "claims": claims,
                "_provenance": {"source": rel, "ranges": [list(r) for r in ranges],
                                "excerpt_line_to_source_line": mapping}}
    return manifest, excerpt


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=str(Path(__file__).resolve().parents[2]))
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent))
    args = ap.parse_args()
    repo, out = Path(args.repo), Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    for name, (rel, ranges, specs) in TARGETS.items():
        manifest, excerpt = build(repo, name, rel, ranges, specs)
        (out / f"excerpt-{name}.txt").write_text(excerpt, encoding="utf-8")
        (out / f"claims-{name}.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        print(f"{name}: {len(manifest['claims'])} claims, excerpt {len(excerpt.splitlines())} lines from {rel}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
