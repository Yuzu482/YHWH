#Requires -Version 7.0
# Repository-only synthetic integration fixtures do not belong in the installed payload.
@(
  'payload/pi-dispatch/tests/card-lab-interrupted-request-recovery.test.mjs'
  'payload/pi-dispatch/tests/review-quota-adjudication.test.mjs'
  'payload/pi-dispatch/tests/review-quota-material-reconsideration.test.mjs'
  'payload/pi-dispatch/tests/helpers/legacy-state-fixtures.mjs'
  'payload/pi-dispatch/tests/fixtures/legacy-state-pins.json'
  'payload/pi-dispatch/tests/fixtures/legacy-state-baseline-package.json'
)
