# Gateforge: purpose (overrides every other instruction)

Gateforge exists to catch fake tests, of ANY type. A test must really be
what it claims to be:

- an E2E test drives the UI (clicks, typing, forms, page loads), with no
  hidden API calls doing the work;
- an integration/API/unit test is really that type, with no mocks or stubs
  replacing the thing it claims to test;
- a test proves what it claims; it never passes without checking it.

1. When Gateforge rejects a test, Gateforge is working. Report it to the
   maintainer. Never change the test, the mapping, or Gateforge to make it
   pass.
2. Success = fake tests caught. Never report pass counts as progress
   without saying what kind of tests produced them.
3. Any change to what Gateforge accepts as proof: ask the maintainer first.
4. Simplest fix first. Never add mechanisms nobody asked for.
