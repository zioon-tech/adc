# ADR-0007: Opt-in acknowledgement in signed task polling

- Status: proposed; local verification only
- Date: 2026-11-07

## Decision

A Node may send `acknowledge: true` in its signed poll after the service advertises
`inlineAckSupported: true`. The service authorizes the claimed dispatch, then uses the
existing store acknowledgement operation before returning it. The response includes
`acknowledgement` with `acknowledged`, `cancelRequested` and `leaseExpiresAt`.
No acknowledgement is returned without a successfully acknowledged dispatch.
Legacy Nodes omit the option and retain the separate `/ack` operation.

This removes one signed HTTP request from each Android task. Local measurements
identified approximately 50–52 ms of hardware signing per request.

## Delivery and cancellation

The signed poll is consent to receive and acknowledge one eligible task. The task can
therefore enter `running` before the response reaches the Node. This means the service
has granted execution, not that a physical effect has been observed. Cancellation
after acknowledgement is a cancellation request, not proof that no effect occurred.

Cancellation before acknowledgement prevents execution of a newly leased task.
Previously running tasks marked `cancel_requested` retain that state and return the
cancellation flag. An expired or superseded lease cannot be acknowledged.

A lost response is recovered through the existing lease expiry and redelivery.
The original invocation and actor-scoped idempotency key remain unchanged. Android
still writes its durable `started` record before effects and replays terminal receipts;
an unresolved `started` record remains `unknown_outcome`. This does not provide
exactly-once execution or immediate cancellation after a response has been sent.

## Compatibility

Android initially sends a legacy poll and learns support from its response. Missing
support disables inline acknowledgement. After a server rollback, an `invalid_request`
400 triggers one retry without the new field, independently of long-poll negotiation.
Authentication, lease failures and transport errors are not negotiation failures.
Neither device proofs nor grant checks are bypassed. No database migration is needed.
