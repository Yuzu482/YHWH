# Gateway module lifecycle

The gateway has a synchronous service-construction registry and asynchronous,
reverse-order disposal. This is a trusted host JavaScript API, not an MCP tool,
a dynamic package loader, or a replacement for Pi authorization checks.

## Managed services

`createGatewayRuntime(options)` keeps its synchronous API. It constructs audit,
circuit, ledger, writeLocks, taskMonitor, dispatch, lsp and executor services.
Named dependencies determine startup and teardown order. The generic registry in
`extensions/module-lifecycle.js` rejects duplicate names, missing dependencies
and cycles before calling factories. An executor stops before its dependencies;
the audit service is released last.

Factories must return synchronously. Use the supplied `defer(cleanup)` to record
each acquisition during construction. Cleanup callbacks may return promises.
The factory's returned service is disposed before its earlier registered effects.
Native async factories are rejected without running; promise-returning factories
are unsupported and must not perform asynchronous resource acquisitions.

If construction fails, the thrown error has a `cleanup` promise. Await it to
observe rollback completion or failure. Cleanup is attempted once per registered
effect, in reverse order, even when another cleanup throws. Failures are reported
as aggregate errors, not silently converted to successful shutdown.

## Ownership and startup replacement

Existing options (`auditLogger`, `circuitState`, `requestLedger`, `writeLocks`,
`taskMonitor`, `executor`, `dispatchFn`, `lspFn`) still work. Injected objects are
borrowed by default: the registry does not close them. Use `ownedModules` with
module IDs to transfer cleanup ownership. This makes ownership explicit compared
with the previous unconditional close of injected audit/circuit/ledger objects.

The gateway still stops admission and drains its executor on shutdown, including
an injected executor. An executor must be dedicated to this runtime; sharing it
between live gateways is unsupported. Borrowed audit/ledger services can still
receive normal record/prune calls; borrowed means no ownership of disposal.

For construction-time substitution, supply `moduleFactories` keyed by the module
IDs above. Each factory receives `{ dependencies, defer }` and returns the same
service interface as the built-in implementation. Factory-created services are
owned. Optional service `close()` is awaited. Unknown IDs and conflicts between
a factory and its legacy injected option are rejected before factory execution.
Use `defer` for additional resources, not to register the same `close()` twice.

## Idle-only adapter replacement

Only `dispatch` and `lsp` can be replaced while the gateway is running:

```js
await runtime.replaceAdapter('dispatch', {
  create({ defer }) {
    // Create a fresh adapter implementing the existing dispatch function API.
    const adapter = makeDispatchAdapter();
    defer(() => adapter.close());
    return adapter.run.bind(adapter);
  },
});
```

`makeDispatchAdapter` above is application-supplied. Alternatively provide
`dispose(service)` alongside `create`; cleanup must be owned exactly once.
Adapters still sit behind existing route, scope, resource, ledger and result
validation. No new replacement tool or arbitrary import path is exposed to MCP.

Replacement is rejected while a request, queued task, pending monitor submission,
LSP operation, probe or authentication operation is outstanding. This includes
result validation and ledger/audit work after scheduler execution ends. Admission
closes synchronously before preparing the candidate. A valid candidate replaces
the old adapter only after its cleanup finishes. Candidate initialization or
validation failure rolls back the candidate and preserves the old adapter. If
candidate rollback or old-adapter cleanup fails, the gateway fails closed.

Stateful services remain pinned during runtime: replacing them could discard
idempotency records, circuit state, locks, monitor history or queued work. They
can be configured at startup, not hot-swapped. Concurrent replacement is rejected;
shutdown waits for a replacement already in progress.

## Shutdown and diagnostics

Shutdown immediately rejects new work, drains/aborts scheduler work under the
existing deadlines, and waits for admitted operations before disposing services.
If an operation ignores cancellation and outlives the deadline, shutdown returns
`disposed:false` and phase `draining`. Dependencies remain open. After that work
settles, call `shutdown()` again to finish disposal; admission never reopens.
Repeated successful shutdown calls share the same promise and do not repeat
cleanup. The HTTP shutdown helper rejects incomplete disposal and still closes
connections when runtime cleanup fails.

Cleanup hooks are trusted host code and must settle; arbitrary hung disposer
promises cannot be forcibly cancelled safely. Replacement waits for those hooks.

`list_capabilities.lifecycle` reports phase, module state, generations, ownership,
dependencies and replacement eligibility. `inFlight` counts internal operation
leases (a request can hold more than one), not model calls. Readiness is false
during replacement, draining, shutdown or failure. These diagnostics contain no
service objects, function bodies or credentials.

## Verification

Run `node --test tests/module-lifecycle.test.mjs tests/gateway-lifecycle.test.mjs`
for lifecycle and loopback MCP fixtures. The fixtures use local fake adapters;
they do not prove a live provider migration, external editor operation or
replacement of the already-running installed gateway. Deploying updated source
to an installed runtime and restarting it are separate operations.
