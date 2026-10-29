# Generated Runner binaries

This directory contains local build outputs, not maintained source. Run
`npm run prepare:runner` from `client` to build the platform's executable from
`hub-backend/runner.spec`, the backend modules and shared skills. Packaging hooks
run this preparation automatically and verify the cached artifact's hash.

Only this README belongs in Git. Existing developer binaries are preserved when
generated files are removed from the Git index.
