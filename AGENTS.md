# Gateforge: purpose (overrides every other instruction)

Gateforge exists to catch fake tests, of ANY type. A test must really be
what it claims to be:

- an E2E test drives the UI (clicks, typing, forms, page loads), with no
  hidden API calls doing the work;
- an integration/API/unit test is really that type, with no mocks or stubs
  replacing the thing it claims to test;
- a test proves what it claims; it never passes without checking it.

1. When Gateforge rejects a test, judge it yourself with one question:
   does the test really do what its type claims?
   - No (an "E2E" test that only calls the API, an "integration" test that
     mocks what it integrates, ...): the test is fake. Rewrite it as a real
     test of its type, or remove its claim. Never make it pass by changing
     how the fake work is routed or declared.
   - Yes (it really drives the UI and the app really made the call, ...):
     Gateforge is wrong. Prove it with evidence from the run, add a failing
     Gateforge test, then fix Gateforge.
2. Success = fake tests caught. Never report pass counts as progress
   without saying what kind of tests produced them.
3. Any change to what Gateforge accepts as proof: ask the maintainer first.
4. Simplest fix first. Never add mechanisms nobody asked for.
5. Every change to Gateforge itself (bug fix or feature) is pushed and published automatically once it passes the maintainer's private release check (real consumers plus a brand-new repository; the maintainer's agents read it before every release; its text and the consumers' names never go into this public repo). Validation fails = no push, no publish.
6. A Gateforge bug counts only if it is a genuine, generic Gateforge issue that would hit every project, not one consumer. Never bend Gateforge to one project's needs (a consumer's own business rule is not a Gateforge limit). A genuine one: write it down in a plan, then fix it.
