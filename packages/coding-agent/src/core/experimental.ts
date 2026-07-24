export function areExperimentalFeaturesEnabled(): boolean {
	return process.env.PI_EXPERIMENTAL === "1";
}

/** Whether schema-inspired decision tracking is active. Always true in this harness version. */
export function isSchemaDecisionTrackingEnabled(): boolean {
	return true;
}
