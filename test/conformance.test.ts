import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { describe, expect, it } from "vitest";
import { freshStorage } from "./helpers.ts";

// The upstream conformance suite is the acceptance gate for this backend.
// Every case runs in its own temporary PostgreSQL schema.
registerStorageConformance(
	{ describe, expect, it },
	"PostgresStorage",
	async (use) => {
		const fixture = await freshStorage();
		try {
			await use(fixture.storage);
		} finally {
			await fixture.cleanup();
		}
	},
);
