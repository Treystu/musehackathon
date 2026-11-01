# Privacy

This document describes what the shipped system does, in plain terms. It states
no figures beyond what the code and configuration actually set.

## What is counted

Metering uses one aggregate counter. It counts only requests, tokens, spend,
and error classes, in total.

It never stores searches, keys, query text, IP addresses, or content. No
per-search or per-person record exists in this store: only the running totals
needed to operate the service and to stop it when the allowance is used up.

A hard budget shutoff is kept: when the configured budget is reached, further
shared-allowance calls stop rather than continuing to spend. Any per-client cap
is configured at the meter; this text states no cap value, because the value is
the operator's setting, not a property of the product.

## What is sent to the model

Ask and Explain reach the model through this site's own endpoints
(`/api/muse/intent`, `/api/muse/explain`, `/api/muse/transcribe`). Wherever
the feature allows, the browser sends structured slots — mode, geography hints,
and metric hints drawn from the allowlist — not raw query text. Where a feature
cannot work from slots alone, raw query text is sent, and that limit is shown
to the visitor rather than hidden.

A standing disclosure accompanies model wording: figures are CivicScope's,
shown with source and vintage, and the wording is the model's reading of those
shown figures, never an additional source.

## Fair-housing protections are mechanical

Fair-housing protections are enforced by mechanical gates in code, not by
requests in a prompt. Filter keys are limited to an allowlist in code, so
protected-class and proxy keys cannot be used as filters by construction. Model
wording is checked in code before display, and wording that does not pass is
withheld rather than shown with a warning.

Asking the model nicely is never the protection. If the code gate does not
pass, the result does not reach the visitor.

## Bring your own key (optional)

Bringing your own key is optional. The shared allowance needs no key.

If a visitor chooses to supply a key, it is stored only in that visitor's own
browser storage. It is sent only to api.meta.ai, from that visitor's browser,
for their own calls, and the spend is the visitor's own. It is never sent to
or stored by CivicScope's servers. Clearing browser storage removes it.

## Diagnostics

The diagnostics panel keeps counters of validator-withhold and error classes,
stored in the visitor's browser only. Its export is rebuilt from validated
counters, so it is structurally unable to carry a query or a key.

## Tracking and logging

There is no tracking, no analytics, and no search logging. The aggregate
counter described above is the only counting kept, and it holds totals only —
never searches, keys, query text, IP addresses, or content.

## Plain summary

Only totals are counted, in one place, to run the service and to stop at the
budget. Structured choices are sent instead of raw text wherever the feature
allows. Safety rules live in code. An optional personal key never leaves the
visitor's browser except to the model provider for their own use.
