"""Gateforge persistence claim INTENTS writer (server-witnessed channel).

THE CONTRACT (this file is only a convenience writer — the JSONL line is
what matters):

  File:      ``$GATEFORGE_STATE_DIR/spool/$GATEFORGE_RUN_ID/persistence-intents.jsonl``
  Protocol:  one JSON object per line, UTF-8, terminated by ``\\n``
             (canonical JSON escapes control characters, so lines are
             NUL-safe; consumers parse a line only once its newline is
             written — partial writes are never misparsed).

  Line shape::

      {"entity": "tenant.lead_push_outbox",
       "operation": "create",              # create|read|update|delete
       "phase": "pre",                     # pre|post
       "intent": "expect-absent",          # expect-present|expect-absent
       "key": "<entity key>",              # scalar, or column-keyed object
       "claimId": "tenant.lead_push_outbox:persistence:create",
       "testId": "<the claim's test id>",  # sidecar logical key for mapped tests
       "sequence": 1}                      # 1-based, strictly increasing per claimId

TRUST MODEL (non-negotiable): the supervised test process is UNTRUSTED.
It may only WRITE intents — it can never stamp evidence. The trusted CLI
drain forwards each intent to the witness over the verifier-key
supervisor surface (``GATEFORGE_WITNESS_VERIFIER_KEY`` never reaches this
process); the WITNESS executes the resource's adapter ``probeServer``
against the app database itself and, only then, stamps a witnessed
``persistence.entity`` record with ``channel: "server"``. A missing
adapter/probe, an unregistered obligation, or a replayed sequence
resolves to a typed failure — never to satisfaction.

Usage (pytest, create postcondition — absent BEFORE, present AFTER)::

    from gateforge_persistence_intents import gateforge_intent, PRE_INTENT_SETTLE_SECONDS

    def test_booking_and_outbox_commit_atomically():
        gateforge_intent("tenant.lead_push_outbox", "create", "pre",
                         "expect-absent", "<booking_id>",
                         "tenant.lead_push_outbox:persistence:create",
                         "<claim testId>", 1)
        time.sleep(PRE_INTENT_SETTLE_SECONDS)  # allow one trusted drain tick
        ...  # the real mutation the test performs against the app
        gateforge_intent("tenant.lead_push_outbox", "create", "post",
                         "expect-present", "<booking_id>",
                         "tenant.lead_push_outbox:persistence:create",
                         "<claim testId>", 2)

TIMING: ``pre`` intents are observed by the trusted drain at its next
poll (default cadence 50ms). The witness records whatever is true when
IT looks, so a mutation racing ahead of the probe honestly grades
``entityAbsent: false`` and the create postcondition FAILS CLOSED —
settle one drain tick (``PRE_INTENT_SETTLE_SECONDS``) between the pre
intent and the mutation to keep honest runs green.
"""
import json
import os
import time

__all__ = ["intents_file", "gateforge_intent", "PRE_INTENT_SETTLE_SECONDS"]

#: Settle time (> one default drain poll) between a ``pre`` intent and
#: the mutation, so the trusted drain observes the before-state.
PRE_INTENT_SETTLE_SECONDS = 0.15


def intents_file(state_dir=None, run_id=None):
    """Resolve the run's intents spool path (env-carried run identity)."""
    state_dir = state_dir or os.environ["GATEFORGE_STATE_DIR"]
    run_id = run_id or os.environ["GATEFORGE_RUN_ID"]
    return os.path.join(state_dir, "spool", run_id, "persistence-intents.jsonl")


def gateforge_intent(entity, operation, phase, intent, key, claim_id, test_id, sequence):
    """Append one persistence claim intent (see module docstring).

    A failed append never crashes the test: the claim then simply stays
    blocking without its witnessed record (fail closed).
    """
    line = json.dumps(
        {
            "entity": str(entity),
            "operation": operation,
            "phase": phase,
            "intent": intent,
            "key": key,
            "claimId": str(claim_id),
            "testId": str(test_id),
            "sequence": int(sequence),
        },
        ensure_ascii=True,
        separators=(",", ":"),
    )
    try:
        path = intents_file()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    except OSError as error:  # pragma: no cover - env misconfiguration
        print(f"[gateforge] cannot append persistence intent: {error}")
