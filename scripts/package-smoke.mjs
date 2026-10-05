import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const work = mkdtempSync(join(tmpdir(), "pi-durable-package-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
function run(command, args, cwd) {
	execFileSync(command, args, { cwd, stdio: "inherit", timeout: 180_000, shell: process.platform === "win32" });
}
try {
	// Exercise prepack, rather than relying on a previously built dist directory.
	run(npm, ["pack", "--pack-destination", work], root);
	const tarball = readdirSync(work).find((file) => file.endsWith(".tgz"));
	assert(tarball, "npm pack did not produce a tarball");
	writeFileSync(join(work, "package.json"), JSON.stringify({
		private: true,
		type: "module",
		dependencies: {
			[manifest.name]: `file:${join(work, tarball)}`,
			// Keep the example model registry aligned with the validated upstream dependency set.
			"@earendil-works/pi-ai": manifest.devDependencies["@earendil-works/pi-ai"],
		},
		devDependencies: {
			typescript: manifest.devDependencies.typescript,
			// Upstream @google/genai declarations import this optional peer even when
			// unused. Install it only in the fixture to keep skipLibCheck=false.
			"@modelcontextprotocol/sdk": "^1.25.2",
		},
	}));
	// Install in isolation: no workspace's devDependencies can mask missing published types.
	run(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund"], work);
	writeFileSync(join(work, "smoke.ts"), `
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import {
  openNodePostgresStorage, nodePostgresDatabase, PostgresStorage, deleteConversation,
  type NodePostgresStorageOptions, type PostgresDatabase,
} from "${manifest.name}";
import { PostgresStorage as CoreStorage } from "${manifest.name}/core";
import { openNodePostgresStorage as NodeOpen } from "${manifest.name}/node";

assert.equal(CoreStorage, PostgresStorage);
assert.equal(NodeOpen, openNodePostgresStorage);
assert.equal(typeof deleteConversation, "function");
assert.equal(typeof nodePostgresDatabase, "function");
const config: NodePostgresStorageOptions = { config: { connectionString: "postgres://example.invalid/test" } };
const models = createModels();
models.setProvider(anthropicProvider());
// Compile the documented integration without a database or a model API call.
async function example(database: PostgresDatabase) {
  const storage = await PostgresStorage.open(database);
  const harness = await Harness.open(storage, { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
  try { return await harness.root(BACKGROUND_CONTEXT); }
  finally { await harness.close(BACKGROUND_CONTEXT); }
}
void example; void config;
console.log("Published package imports and consumer types OK");
`);
	writeFileSync(join(work, "tsconfig.json"), JSON.stringify({
		compilerOptions: {
			target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext", strict: true,
			exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true,
			skipLibCheck: false, outDir: "out",
		},
		include: ["smoke.ts"],
	}));
	run(process.execPath, [join(work, "node_modules/typescript/bin/tsc")], work);
	run(process.execPath, [join(work, "out/smoke.js")], work);
} finally {
	rmSync(work, { recursive: true, force: true });
}
