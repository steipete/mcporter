// No-op hook retained for compatibility with the Sweetistics configuration.
// Signoz MCP occasionally retries on transient errors; keeping this module
// allows `NODE_OPTIONS=--require=./scripts/mcp_signoz_retry_patch.cjs` to load
// without throwing if teams reuse the same entry.

module.exports = {
	// Export a no-op hook so consumers can keep requiring this patch file safely.
	onRetry() {},
};
