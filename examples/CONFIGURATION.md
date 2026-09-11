# Configuration

Edit private `config.json` only while stopped, or use the local settings UI. Never commit real state or credentials.

`tailscaleCommand` and `pythonCommand` can each specify an absolute executable `file` and an `args` array. These are trusted owner settings, never remotely supplied command configuration. Do not use test fixtures in production.

The folder picker names shared roots automatically; the path form supports explicit names. Shell working directories are not sandboxes. Desktop permission resets on every restart. Changing public origin requires reconnecting clients. Never proxy the administrative listener.
