# Website analytics: what is measured and how it is protected

## What the numbers mean

| Figure | Definition |
|---|---|
| Page views | Each recorded page load. Repeats of the same page by the same visitor within 30 seconds are dropped. |
| Daily visitors | Distinct visitor markers for one UTC day. The marker changes every day. |
| Daily visitors, summed | Daily visitor counts added together across a range. One person on two days is counted twice. This is **not** a unique-visitor figure. |
| Unique visitors | **Not reported.** Markers change daily, so they cannot be merged across days. |
| Sessions | **Not reported.** No session identifier is stored. |
| Clicks | Clicks on tracked links. Repeats of the same click within 10 seconds are dropped. |

Dates and hours are UTC. Figures start from the day collection began. Nothing earlier is recorded.

## What is not stored

- IP addresses and user-agent strings are not stored. They are used only to compute the daily marker, which is a keyed hash.
- No cookies, local storage or fingerprinting are used on the public site.
- Do Not Track is respected by the public script.
- Raw rows are kept for 400 days. A nightly job deletes older rows.

## Collection protections (Edge Function `collect`)

These are the protections that are actually in place:

1. **Origin check.** Requests must carry the site's origin. Browsers send this on the beacon, so other websites' scripts are refused. **This is not a security control.** A non-browser client can set any Origin header, so the limits below apply to it too.
2. **Bot filter.** Requests with a missing user agent, or one that matches common crawler and tool names, are not stored. A client can change its user agent, so this only stops well-behaved crawlers.
3. **Input validation.** Event types and click targets are allow-listed. Paths are limited to a safe character set, and query strings are dropped. Referrers are reduced to their host name. Campaign tags are cleaned and length-limited. Bodies larger than 2 KB are refused.
4. **Duplicate suppression.** The same visitor marker sending the same event on the same page within 30 seconds (page view) or 10 seconds (click) is not stored twice.
5. **Per-visitor limit.** 200 events per visitor marker per hour.
6. **Site-wide limit.** 5,000 events per hour across all visitors, to protect the database.

### Known limits

- A determined script can send requests with any origin, user agent and address, so it can still add events. The limits bound how much it can add. They do not stop it.
- The visitor address is taken from the first `x-forwarded-for` value. A client can supply that header, so a client can vary its per-visitor marker. The site-wide limit still applies.
- Ad blockers prevent some browsers from sending events, so counts are lower than real traffic.

## Administrator-only access

- The browser can only read aggregated results, from `analytics_summary`. That function checks that the signed-in user is the administrator. Raw rows are not readable by anonymous users or signed-in non-administrators.
- The CSV export is built in the browser from the aggregated result for the selected range. It contains only daily counts for that range.
- Retention deletion (`analytics_purge_older_than`) is administrator-only, and it can also be run manually.

## Retention

- A nightly job (`analytics-retention-400d`, 03:17 UTC) deletes events older than 400 days. It runs inside the database through pg_cron. It has no public endpoint.
