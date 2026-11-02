# Claude Code handoff

Read `AGENTS.md` for project and release rules, then `SECURITY_REVIEW.md` for the
security review scope, validation commands, evidence, and open questions.

This repository is a dependency-free Node.js service that can place real paid
phone calls. Review using dummy configuration and the network-isolated Docker
fixtures. `.env` contains live credentials and `data/` contains operational
events: do not read, copy, upload, or commit either during the review.

The requested handoff is for an independent source security review. Report
findings with file/line references and reproducible evidence before making
changes. Existing remediation claims must be checked against current code.
