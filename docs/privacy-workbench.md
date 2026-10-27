# Privacy — workbench copy

> WORKBENCH COPY — NOT FINAL (final submission privacy text is S11/S12)

This document is working copy for the product surface only. It describes what the system does in plain terms. It makes no submission claims and states no figures beyond what the code and configuration actually set.

## What is counted (Q1 aggregate counter)

Metering uses one Durable Object that keeps an aggregate counter. It counts only requests, tokens, spend, and error classes in total.

It never stores searches, keys, query text, IP addresses, or content. There is no per-search or per-person record in this store: only the running totals needed to operate the service and to stop it when the allowance is used up.

A hard budget shutoff is kept: when the configured budget is reached, further shared-allowance calls stop rather than continuing to spend. Any per-client cap is set at meter config; this copy states no cap value because none is stated here on purpose.

## What is sent to the model (D5 minimisation)

Wherever the feature allows, the browser sends structured slots to the proxy — mode, geography hints, and metric hints drawn from the allowlist — not raw query text. Raw query text is avoided wherever the feature allows; where a feature cannot work from slots alone, that limit is shown to the visitor rather than hidden.

A standing disclosure accompanies model wording: figures are CivicScope's, with source and vintage shown alongside each figure, and the wording is the model's reading of those shown figures, not an additional source.

## Fair-housing protections are mechanical

Fair-housing protections are enforced by mechanical gates in code, not by requests in a prompt. Filter keys are limited to an allowlist in code, so protected-class and proxy keys cannot be used as filters by construction. Model wording is checked in code before display, and wording that does not pass is withheld rather than shown with a warning.

Asking the model nicely is never the protection. If the code gate does not pass, the result does not reach the visitor.

## Bring your own key (optional)

Bringing your own key is optional. The shared allowance needs no key.

If a visitor chooses to supply a key, it is stored only in that visitor's own browser localStorage. It is sent only to the Meta origin for that visitor's own calls, and the spend is the visitor's own spend on their own account. The key is not sent to the shared meter as content and is not stored on the server. Clearing browser storage removes it.

## Language at launch (D7)

The product is English-only at launch. That is an honest boundary, not a temporary label: non-English queries are outside the launch scope, and the product does not claim translation or multilingual support it does not provide.

## Tracking and logging

There is no tracking, no analytics, and no search logging. The aggregate counter described above is the only counting kept, and it holds totals only — never searches, keys, query text, IP addresses, or content.

## Plain summary

Only totals are counted, in one place, to run the service and to stop at the budget. Structured choices are sent instead of raw text wherever the feature allows. Safety rules live in code. An optional personal key never leaves the visitor's browser except to the model provider for their own use.
