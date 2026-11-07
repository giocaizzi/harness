# NFR table

Fill every row with a number and how it is measured. "Fast" and "highly available" are not values. Mark unknowns `TBD (owner, date)`; a TBD blocks approval.

| NFR | Target | Measured by | Consequence if missed |
|---|---|---|---|
| Latency | p50 / p99 per endpoint or job, e.g. p99 < 300 ms | tracing, load test | |
| Throughput | steady and peak req/s or msgs/s, growth per year | load test | |
| Availability | e.g. 99.9% monthly (43 min budget) | SLO dashboard | |
| Durability / RPO | max data loss, e.g. 5 min | backup + restore drill | |
| Recovery / RTO | max time to restore, e.g. 1 h | restore drill | |
| Consistency | strong or eventual; staleness bound in seconds | | |
| Data volume | rows/GB now and in 2 years; retention | | |
| Security / compliance | data classes, residency, audit needs | | |
| Cost ceiling | monthly amount, per-unit cost | billing report | |

## Derive, then check

- Peak = steady x burst factor; size for peak, test at 2x.
- Availability of a chain = product of its parts; every synchronous dependency lowers it.
- Every row must change a decision (a queue, a replica, a region). A row that changes nothing is deleted.
