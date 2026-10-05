import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { describe, expect, it } from "vitest";
import { freshStorage } from "./helpers.ts";

// The upstream conformance suite is the acceptance gate for this backend.
// Every case runs against a freshly reset schema over one PostgreSQL database.
registerStorageConformance(
	{ describe, expect, it },
	"PostgresStorage",
	async (use) => {
		const { storage } = await freshStorage();
		try {
			await use(storage);
		} finally {
			await storage.close(BACKGROUND_CONTEXT);
		}
	},
);
