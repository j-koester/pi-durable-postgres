# Security

This package is alpha. Security fixes target the latest release and its documented,
validated Pi Durable peer version.

Report vulnerabilities through GitHub private vulnerability reporting at
https://github.com/j-koester/pi-durable-postgres/security/advisories/new
when enabled. If private reporting is unavailable, open a minimal issue requesting
a private contact channel, without exploit details, database dumps or credentials.

Do not include personal conversation contents or access tokens in public issues.

## Operational boundaries

- Use TLS, least-privilege database roles and an isolated schema/database.
- Advisory locks coordinate participating adapters; they do not authorize callers
  or stop arbitrary external SQL.
- The current deletion API is maintenance-only. Do not bypass its ownership guard.
- Backups, WAL, logs, session documents and external copies need their own retention
  and deletion policies. This library alone cannot establish GDPR compliance.
- Shared/transaction-pooled connections and automatic reconnects cannot preserve
  the current ownership protocol.
